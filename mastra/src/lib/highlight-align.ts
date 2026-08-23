// mastra/src/lib/highlight-align.ts
//
// Surlignage par ALIGNEMENT (et non plus par recherche de phrases).
// On extrait une fois le flux de mots du PDF avec leurs positions, puis on aligne
// le texte de CHAQUE chunk comme un bloc contigu sur ce flux. Avantages vs
// `computeHighlights` :
//  - couverture bien supérieure (la normalisation absorbe Markdown/accents/ponctuation) ;
//  - surlignages contigus SANS parasites (on aligne un bloc, pas des phrases isolées).
import * as mupdf from 'mupdf';
import type { PageHighlights } from './highlight.js';

interface DocWord {
  norm: string; // forme normalisée (minuscule, sans accent, alphanum only)
  page: number; // 1-based
  line: number; // identifiant de ligne global (pour regrouper les rects)
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChunkAlign {
  id?: string;
  words: number; // nb de mots normalisés du chunk
  matched: number; // nb de mots retrouvés
}

export interface AlignResult {
  pages: PageHighlights[];
  report: ChunkAlign[];
}

// minuscule + suppression des diacritiques + garde alphanumérique uniquement.
export function normalizeWord(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function unionQuad(r: { x: number; y: number; w: number; h: number } | null, quad: number[]) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  if (!r) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const nx = Math.min(r.x, x0), ny = Math.min(r.y, y0);
  return { x: nx, y: ny, w: Math.max(r.x + r.w, x1) - nx, h: Math.max(r.y + r.h, y1) - ny };
}

// Extrait le flux ordonné des mots du PDF (texte normalisé + position + page + ligne)
// et les dimensions de chaque page.
function extractDocWords(pdfBytes: Uint8Array): { words: DocWord[]; dims: Map<number, { w: number; h: number }> } {
  const doc = mupdf.PDFDocument.openDocument(pdfBytes, 'application/pdf');
  const words: DocWord[] = [];
  const dims = new Map<number, { w: number; h: number }>();
  let lineCounter = 0;
  try {
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const pageNo = i + 1;
      const page = doc.loadPage(i);
      try {
        const b = page.getBounds();
        dims.set(pageNo, { w: b[2] - b[0], h: b[3] - b[1] });
        const st = page.toStructuredText('preserve-whitespace');
        try {
          let raw = ''; // caractères bruts du mot courant
          let rect: { x: number; y: number; w: number; h: number } | null = null;
          const flush = () => {
            if (raw) {
              const norm = normalizeWord(raw);
              if (norm && rect) words.push({ norm, page: pageNo, line: lineCounter, ...rect });
            }
            raw = '';
            rect = null;
          };
          st.walk({
            beginTextBlock: () => {},
            endTextBlock: () => {},
            beginLine: () => { lineCounter++; },
            endLine: () => { flush(); },
            beginStructure: () => {},
            endStructure: () => {},
            onChar: (c: string, _origin: unknown, _font: unknown, _size: number, quad: number[]) => {
              if (/\s/.test(c)) { flush(); return; }
              raw += c;
              rect = unionQuad(rect, quad);
            },
          } as any);
          flush();
        } finally {
          st.destroy?.();
        }
      } finally {
        page.destroy();
      }
    }
  } finally {
    doc.destroy();
  }
  return { words, dims };
}

const SKIP_WINDOW = 6; // tolérance : mots divergents/absents absorbés dans une petite fenêtre
const MAX_ANCHORS = 120;

// Tous les runs candidats d'UNE ligne : pour chaque occurrence de son mot le plus
// rare (l'ancre), on étend un run contigu vers l'avant (tolérance SKIP_WINDOW).
// Aligner ligne par ligne (et non le chunk d'un bloc) gère les mises en page
// multi-colonnes où l'ordre de lecture du PDF diffère de la linéarisation d'Albert.
function candidateRuns(seq: string[], docWords: DocWord[], posIndex: Map<string, number[]>): number[][] {
  if (!seq.length) return [];
  let anchorCi = -1;
  let anchorPositions: number[] = [];
  let bestFreq = Infinity;
  for (let ci = 0; ci < seq.length; ci++) {
    const pos = posIndex.get(seq[ci]);
    if (pos && pos.length && pos.length < bestFreq) {
      bestFreq = pos.length;
      anchorCi = ci;
      anchorPositions = pos;
    }
  }
  if (anchorCi < 0) return [];
  // Affinage BIGRAMME : si l'ancre (mot le plus rare) reste ambiguë (plusieurs
  // positions) et qu'un mot la suit dans le chunk, on ne garde que les positions
  // où ce mot suivant apparaît aussi juste après (une PAIRE est bien plus rare
  // qu'un mot seul). Débloque les lignes de mots communs / tableaux. Repli
  // prudent : si l'affinage vide tout, on garde les positions d'origine.
  if (anchorCi + 1 < seq.length && anchorPositions.length > 1) {
    const next = seq[anchorCi + 1];
    const refined = anchorPositions.filter((di) => {
      for (let k = 1; k <= SKIP_WINDOW && di + k < docWords.length; k++) {
        if (docWords[di + k].norm === next) return true;
      }
      return false;
    });
    if (refined.length) anchorPositions = refined;
  }
  const runs: number[][] = [];
  for (const anchorDi of anchorPositions.slice(0, MAX_ANCHORS)) {
    const start = anchorDi - anchorCi;
    if (start < 0) continue;
    const m: number[] = [];
    let di = start;
    for (let ci = 0; ci < seq.length; ci++) {
      let found = -1;
      let second = -1; // 2e token consommé en cas de césure
      for (let k = 0; k <= SKIP_WINDOW && di + k < docWords.length; k++) {
        const w0 = docWords[di + k].norm;
        if (w0 === seq[ci]) { found = di + k; break; }
        // CÉSURE : un mot du chunk = deux tokens PDF consécutifs recollés
        // (« anticonstitution- » + « nellement »). On surligne les DEUX fragments.
        if (di + k + 1 < docWords.length && w0 + docWords[di + k + 1].norm === seq[ci]) {
          found = di + k; second = di + k + 1; break;
        }
      }
      if (found >= 0) {
        m.push(found);
        if (second >= 0) { m.push(second); di = second + 1; }
        else di = found + 1;
      }
    }
    if (m.length) runs.push(m);
  }
  return runs;
}

// Choisit le meilleur run : le plus long, puis (localité) le plus proche du curseur.
// La localité évite les parasites : une ligne générique répétée ailleurs prend
// l'occurrence proche du reste du chunk, pas la première venue.
function pickRun(runs: number[][], cursor: number | null): number[] {
  if (!runs.length) return [];
  const maxLen = Math.max(...runs.map((r) => r.length));
  const top = runs.filter((r) => r.length === maxLen);
  if (cursor == null) return top[0];
  let best = top[0];
  let bestDist = Infinity;
  for (const r of top) {
    const d = Math.abs(r[0] - cursor);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
}

// Aligne les lignes d'un chunk avec contrainte de localité.
// Renvoie les indices de docWords retenus.
function alignChunkLines(lines: string[][], docWords: DocWord[], posIndex: Map<string, number[]>): number[] {
  const perLine = lines.map((seq) => candidateRuns(seq, docWords, posIndex));
  // Seed = la ligne dont l'ancre est la plus rare (point de départ le plus fiable).
  let seed = -1;
  let bestRare = Infinity;
  lines.forEach((seq, li) => {
    if (!perLine[li].length) return;
    let bf = Infinity;
    for (const w of seq) { const p = posIndex.get(w); if (p && p.length < bf) bf = p.length; }
    if (bf < bestRare) { bestRare = bf; seed = li; }
  });
  if (seed < 0) return [];

  const matched = new Set<number>();
  const seedRun = pickRun(perLine[seed], null);
  seedRun.forEach((i) => matched.add(i));
  // Descente puis remontée depuis le seed, curseur propagé pour la localité.
  let cursor: number | null = seedRun.length ? seedRun[seedRun.length - 1] : null;
  for (let li = seed + 1; li < lines.length; li++) {
    const r = pickRun(perLine[li], cursor);
    if (r.length) { r.forEach((i) => matched.add(i)); cursor = r[r.length - 1]; }
  }
  cursor = seedRun.length ? seedRun[0] : null;
  for (let li = seed - 1; li >= 0; li--) {
    const r = pickRun(perLine[li], cursor);
    if (r.length) { r.forEach((i) => matched.add(i)); cursor = r[0]; }
  }
  return [...matched];
}

interface DocIndex {
  docWords: DocWord[];
  dims: Map<number, { w: number; h: number }>;
  posIndex: Map<string, number[]>;
}

// Cache borné (LRU) du texte structuré par document. Le PDF servi est immuable,
// donc on ne refait pas le walk mupdf coûteux (synchrone) à chaque ouverture :
// cela borne le coût CPU des appels répétés sur /highlights.
const DOC_INDEX_CACHE_MAX = 8;
const docIndexCache = new Map<string, DocIndex>();

function buildDocIndex(pdfBytes: Uint8Array): DocIndex {
  const { words: docWords, dims } = extractDocWords(pdfBytes);
  const posIndex = new Map<string, number[]>();
  docWords.forEach((wd, i) => {
    const arr = posIndex.get(wd.norm);
    if (arr) arr.push(i);
    else posIndex.set(wd.norm, [i]);
  });
  return { docWords, dims, posIndex };
}

function getDocIndex(pdfBytes: Uint8Array, cacheKey?: string): DocIndex {
  if (cacheKey) {
    const hit = docIndexCache.get(cacheKey);
    if (hit) {
      docIndexCache.delete(cacheKey); // LRU : remet en tête
      docIndexCache.set(cacheKey, hit);
      return hit;
    }
  }
  const idx = buildDocIndex(pdfBytes);
  if (cacheKey) {
    docIndexCache.set(cacheKey, idx);
    if (docIndexCache.size > DOC_INDEX_CACHE_MAX) {
      docIndexCache.delete(docIndexCache.keys().next().value as string); // évince le plus ancien
    }
  }
  return idx;
}

// Point d'entrée : calcule les zones de surlignage par alignement pour des chunks.
// `cacheKey` (ex. clé S3 du PDF) active le cache du texte structuré.
export function computeAlignedHighlights(
  pdfBytes: Uint8Array,
  chunks: Array<{ id?: string; content: string }>,
  cacheKey?: string,
): AlignResult {
  const { docWords, dims, posIndex } = getDocIndex(pdfBytes, cacheKey);

  // page -> line -> rect fusionné
  const perPage = new Map<number, Map<number, { x: number; y: number; w: number; h: number }>>();
  const report: ChunkAlign[] = [];

  for (const ch of chunks) {
    // Découpe en lignes (l'alignement par ligne gère les mises en page complexes).
    // On extrait d'abord le texte visible des liens Markdown [texte](url) : sinon
    // « [mail](mailto:mail) » devient un token géant qui ne matche rien dans le PDF.
    const lines = ch.content
      .split(/\n+/)
      .map((l) => l.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\s+/).map(normalizeWord).filter(Boolean));
    const wordCount = lines.reduce((s, l) => s + l.length, 0);
    const matched = alignChunkLines(lines, docWords, posIndex);
    report.push({ id: ch.id, words: wordCount, matched: matched.length });
    // On surligne TOUT le chunk aligné (bloc contigu), jamais un sous-ensemble
    // mot-à-mot : c'est ce qui évite de surligner des mots isolés répétés ailleurs.
    for (const di of matched) {
      const wd = docWords[di];
      let pageLines = perPage.get(wd.page);
      if (!pageLines) { pageLines = new Map(); perPage.set(wd.page, pageLines); }
      const cur = pageLines.get(wd.line);
      const box = { x: wd.x, y: wd.y, w: wd.w, h: wd.h };
      if (!cur) pageLines.set(wd.line, box);
      else {
        const nx = Math.min(cur.x, box.x), ny = Math.min(cur.y, box.y);
        pageLines.set(wd.line, {
          x: nx, y: ny,
          w: Math.max(cur.x + cur.w, box.x + box.w) - nx,
          h: Math.max(cur.y + cur.h, box.y + box.h) - ny,
        });
      }
    }
  }

  const pages: PageHighlights[] = [];
  for (const [page, pageLines] of [...perPage.entries()].sort((a, b) => a[0] - b[0])) {
    const d = dims.get(page) ?? { w: 0, h: 0 };
    pages.push({ page, width: d.w, height: d.h, rects: [...pageLines.values()] });
  }
  return { pages, report };
}
