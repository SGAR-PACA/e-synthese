import * as mupdf from 'mupdf';

/** Une page et les lignes dans l'ordre de lecture fourni par MuPDF. */
export interface PdfTextPage {
  page: number;
  lines: string[];
}

/**
 * Chunk texte construit localement à partir du PDF réellement servi.
 * Les numéros de page servent au diagnostic et aux métadonnées Albert ; ils ne
 * sont pas ajoutés au contenu afin de ne jamais créer de faux mots à surligner.
 */
export interface PdfTextChunk {
  content: string;
  pageStart: number;
  pageEnd: number;
}

/** Taille par défaut validée sur les PDF métier textuels et tabulaires. */
export const DEFAULT_PDF_CHUNK_SIZE = 1900;

/**
 * Les PDF balisés peuvent contenir un arbre de structure cassé. MuPDF tente
 * alors de le parcourir lors de l'extraction et écrit un avertissement, alors
 * que le texte visible de la page reste parfaitement exploitable.
 *
 * La structure logique n'est pas utilisée par notre pipeline : nous alignons
 * les caractères visibles sur le PDF servi. On retire donc uniquement la
 * référence à l'arbre dans le document MuPDF en mémoire. Les octets du PDF
 * d'origine ne sont ni réécrits ni modifiés ; les coordonnées restent donc
 * celles du fichier affiché par la visionneuse.
 */
export function dropPdfStructureTreeForExtraction(doc: mupdf.PDFDocument): void {
  const root = doc.getTrailer().get('Root');
  if (!root.isDictionary()) return;
  if (!root.get('StructTreeRoot').isNull()) root.delete('StructTreeRoot');
}

function cleanLine(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrait le texte avec MuPDF, sans demander à Albert de reparser le PDF.
 *
 * `preserve-whitespace` est important pour les tableaux : les cellules sont
 * conservées dans l'ordre de lecture du PDF, puis les espaces sont normalisés
 * uniquement à l'intérieur d'une ligne. Les lignes répétées ne sont jamais
 * dédupliquées : elles peuvent contenir des valeurs différentes dans un tableau.
 */
export function extractPdfTextPages(pdfBytes: Uint8Array): PdfTextPage[] {
  const doc = new mupdf.PDFDocument(pdfBytes);
  dropPdfStructureTreeForExtraction(doc);
  const pages: PdfTextPage[] = [];
  try {
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      try {
        const structured = page.toStructuredText('preserve-whitespace');
        const lines: string[] = [];
        let current = '';
        const flush = () => {
          const line = cleanLine(current);
          if (line) lines.push(line);
          current = '';
        };

        try {
          structured.walk({
            beginTextBlock: () => {},
            endTextBlock: () => {},
            beginLine: () => { current = ''; },
            endLine: flush,
            beginStructure: () => {},
            endStructure: () => {},
            onChar: (c: string) => { current += c; },
          } as any);
          // Certains PDF ne ferment pas proprement leur dernière ligne dans
          // l'arbre de structure. Ne pas perdre cette dernière ligne.
          flush();
        } finally {
          structured.destroy?.();
        }
        pages.push({ page: i + 1, lines });
      } finally {
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
  return pages;
}

function splitLongLine(line: string, maxChars: number): string[] {
  const parts: string[] = [];
  let remaining = line;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function validChunkSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PDF_CHUNK_SIZE;
  return Math.max(256, Math.min(Math.floor(value), 6000));
}

/**
 * Regroupe les lignes sans jamais couper une ligne de tableau quand cela peut
 * être évité. Une ligne exceptionnellement longue est découpée sur un espace.
 * Le résultat est déterministe : même PDF, mêmes lignes, mêmes chunks.
 */
export function buildTextChunksFromPages(pages: PdfTextPage[], maxChars = DEFAULT_PDF_CHUNK_SIZE): PdfTextChunk[] {
  const size = validChunkSize(maxChars);
  const chunks: PdfTextChunk[] = [];
  let current: string[] = [];
  let currentLength = 0;
  let pageStart = 0;
  let pageEnd = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({ content: current.join('\n'), pageStart, pageEnd });
    current = [];
    currentLength = 0;
    pageStart = 0;
    pageEnd = 0;
  };

  for (const page of pages) {
    for (const originalLine of page.lines) {
      for (const line of splitLongLine(originalLine, size)) {
        const addedLength = (current.length ? 1 : 0) + line.length;
        if (current.length && currentLength + addedLength > size) flush();
        if (!current.length) pageStart = page.page;
        current.push(line);
        currentLength += (current.length > 1 ? 1 : 0) + line.length;
        pageEnd = page.page;
      }
    }
  }
  flush();
  return chunks;
}

/** Extraction + découpage utilisés par le worker d'ingestion. */
export function buildPdfTextChunks(pdfBytes: Uint8Array, maxChars = DEFAULT_PDF_CHUNK_SIZE): PdfTextChunk[] {
  return buildTextChunksFromPages(extractPdfTextPages(pdfBytes), maxChars);
}
