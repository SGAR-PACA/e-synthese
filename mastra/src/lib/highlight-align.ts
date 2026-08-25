// mastra/src/lib/highlight-align.ts
//
// Surlignage par ALIGNEMENT (et non plus par recherche de phrases).
// On extrait une fois le flux de mots du PDF avec leurs positions, puis on aligne
// le texte de CHAQUE chunk sur ce flux. Les coordonnées sont conservables lors
// de l'ingestion ; les mots non retrouvés ne sont jamais remplacés par un
// rectangle englobant qui inclurait du contenu voisin. Avantages vs
// `computeHighlights` :
//  - couverture bien supérieure (la normalisation absorbe Markdown/accents/ponctuation) ;
//  - surlignages précis SANS parasites (on conserve uniquement les mots alignés).
import * as mupdf from 'mupdf';
import type { PageHighlights } from './highlight.js';
import { dropPdfStructureTreeForExtraction } from './pdf-text.js';

interface DocWord {
  norm: string; // forme normalisée (minuscule, sans accent, alphanum only)
  page: number; // 1-based
  line: number; // identifiant de ligne global (pour regrouper les rects)
  x: number;
  y: number;
  w: number;
  h: number;
}

type Matrix = [number, number, number, number, number, number];
type PdfBounds = [number, number, number, number];

interface PageMetrics {
  w: number;
  h: number;
  pdfBounds: PdfBounds;
}

export interface ChunkAlign {
  id?: string;
  words: number; // nb de mots normalisés du chunk
  matched: number; // nb de mots retrouvés
  matchedTokens?: number; // nb de tokens du chunk retrouvés (césures incluses)
}

export interface AlignResult {
  pages: PageHighlights[];
  report: ChunkAlign[];
}

// Ancre persistable : les coordonnées ont été calculées sur le PDF exact qui
// sera servi par la visionneuse. Elles ne sont utilisables que si `verified`
// est vrai ; une ancre partielle ne doit jamais produire un surlignage partiel
// présenté comme le chunk complet.
export interface ChunkHighlightAnchor extends ChunkAlign {
  pages: PageHighlights[];
  verified: boolean;
  verificationReason?: 'verified' | 'empty' | 'ambiguous' | 'incoherent' | 'missing' | 'duplicate-reuse';
  maxInterlineGap?: number;
}

export interface ChunkAnchorResult {
  anchors: ChunkHighlightAnchor[];
  complete: boolean;
}

// minuscule + suppression des diacritiques + garde alphanumérique uniquement.
export function normalizeWord(s: string): string {
  return s
    .replace(/[œŒ]/g, 'oe')
    .replace(/[æÆ]/g, 'ae')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function unionQuad(r: { x: number; y: number; w: number; h: number } | null, quad: number[]) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  if (!r) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const nx = Math.min(r.x, x0), ny = Math.min(r.y, y0);
  return { x: nx, y: ny, w: Math.max(r.x + r.w, x1) - nx, h: Math.max(r.y + r.h, y1) - ny };
}

// MuPDF expose le texte en coordonnées top-left. PDF.js attend des
// coordonnées PDF user space ; cette transformation est indispensable pour
// les CropBox non nuls, les pages tournées et les UserUnit non standard.
// Dans la version JS utilisée ici, getTransform() est la matrice que PDF.js
// applique à l'espace PDF pour obtenir l'espace d'affichage MuPDF (ce qui se
// vérifie sur un CropBox non nul). On l'inverse donc avant de transformer les
// rectangles extraits, puis on applique la matrice aux quatre coins afin de
// rester correct en cas de rotation.
function transformPoint(point: [number, number], matrix: Matrix): [number, number] {
  const [a, b, c, d, e, f] = matrix;
  return [a * point[0] + c * point[1] + e, b * point[0] + d * point[1] + f];
}

function transformRect(
  rect: { x: number; y: number; w: number; h: number },
  matrix: Matrix,
): { x: number; y: number; w: number; h: number } {
  const points = [
    transformPoint([rect.x, rect.y], matrix),
    transformPoint([rect.x + rect.w, rect.y], matrix),
    transformPoint([rect.x, rect.y + rect.h], matrix),
    transformPoint([rect.x + rect.w, rect.y + rect.h], matrix),
  ];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// Extrait le flux ordonné des mots du PDF (texte normalisé + position + page + ligne)
// et les dimensions de chaque page.
function extractDocWords(pdfBytes: Uint8Array): { words: DocWord[]; dims: Map<number, PageMetrics> } {
  const doc = new mupdf.PDFDocument(pdfBytes);
  dropPdfStructureTreeForExtraction(doc);
  const words: DocWord[] = [];
  const dims = new Map<number, PageMetrics>();
  let lineCounter = 0;
  try {
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const pageNo = i + 1;
      const page = doc.loadPage(i);
      try {
        const b = page.getBounds();
        const displayMatrix = ((page as any).getTransform?.() ?? [1, 0, 0, -1, b[0], b[3]]) as Matrix;
        const matrix = mupdf.Matrix.invert(displayMatrix) as Matrix;
        const pdfPage = transformRect(
          { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] },
          matrix,
        );
        const pdfBounds: PdfBounds = [
          pdfPage.x,
          pdfPage.y,
          pdfPage.x + pdfPage.w,
          pdfPage.y + pdfPage.h,
        ];
        dims.set(pageNo, { w: pdfPage.w, h: pdfPage.h, pdfBounds });
        const st = page.toStructuredText('preserve-whitespace');
        try {
          let raw = ''; // caractères bruts du mot courant
          let rect: { x: number; y: number; w: number; h: number } | null = null;
          const flush = () => {
            if (raw) {
              const norm = normalizeWord(raw);
              if (norm && rect) {
                const pdfRect = transformRect(rect, matrix);
                words.push({ norm, page: pageNo, line: lineCounter, ...pdfRect });
              }
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
interface CandidateRun {
  indices: number[];
  matchedTokens: number;
  skipped: number;
}

interface PickedRun {
  run: CandidateRun;
  ambiguous: boolean;
}

function candidateRuns(
  seq: string[],
  docWords: DocWord[],
  posIndex: Map<string, number[]>,
  blocked = new Set<number>(),
): CandidateRun[] {
  if (!seq.length) return [];
  let anchorCi = -1;
  let anchorPositions: number[] = [];
  let bestFreq = Infinity;
  for (let ci = 0; ci < seq.length; ci++) {
    const pos = posIndex.get(seq[ci])?.filter((di) => !blocked.has(di));
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
        if (!blocked.has(di + k) && docWords[di + k].norm === next) return true;
      }
      return false;
    });
    if (refined.length) anchorPositions = refined;
  }
  const runs: CandidateRun[] = [];
  for (const anchorDi of anchorPositions.slice(0, MAX_ANCHORS)) {
    const start = anchorDi - anchorCi;
    if (start < 0) continue;
    const m: number[] = [];
    let matchedTokens = 0;
    let skipped = 0;
    let di = start;
    for (let ci = 0; ci < seq.length; ci++) {
      let found = -1;
      let second = -1; // 2e token consommé en cas de césure
      for (let k = 0; k <= SKIP_WINDOW && di + k < docWords.length; k++) {
        if (blocked.has(di + k)) continue;
        const w0 = docWords[di + k].norm;
        if (w0 === seq[ci]) { found = di + k; break; }
        // CÉSURE : un mot du chunk = deux tokens PDF consécutifs recollés
        // (« anticonstitution- » + « nellement »). On surligne les DEUX fragments.
        if (
          di + k + 1 < docWords.length &&
          !blocked.has(di + k + 1) &&
          w0 + docWords[di + k + 1].norm === seq[ci]
        ) {
          found = di + k; second = di + k + 1; break;
        }
      }
      if (found >= 0) {
        m.push(found);
        matchedTokens++;
        skipped += found - di;
        if (second >= 0) { m.push(second); di = second + 1; }
        else di = found + 1;
      }
    }
    if (m.length) runs.push({ indices: m, matchedTokens, skipped });
  }
  return runs;
}

// Chemin de confiance maximal : lorsqu'un chunk normalisé apparaît exactement
// une seule fois dans le flux PDF, on conserve cette occurrence sans passer par
// la tolérance de saut. Si plusieurs occurrences exactes existent, il n'existe
// pas de preuve suffisante pour choisir la bonne : on refuse donc le chunk plutôt
// que de surligner arbitrairement la première occurrence.
function exactSequenceRuns(
  seq: string[],
  docWords: DocWord[],
  posIndex: Map<string, number[]>,
): number[][] {
  if (!seq.length) return [];
  const starts = posIndex.get(seq[0]) ?? [];
  const runs: number[][] = [];
  for (const start of starts) {
    if (start + seq.length > docWords.length) continue;
    let exact = true;
    for (let i = 1; i < seq.length; i++) {
      if (docWords[start + i].norm !== seq[i]) {
        exact = false;
        break;
      }
    }
    if (exact) {
      runs.push(Array.from({ length: seq.length }, (_, i) => start + i));
      if (runs.length > 1) break;
    }
  }
  return runs;
}

// Choisit le meilleur run : le plus long, puis (localité) le plus proche du curseur.
// La localité évite les parasites : une ligne générique répétée ailleurs prend
// l'occurrence proche du reste du chunk, pas la première venue.
function pickRun(runs: CandidateRun[], cursor: number | null): PickedRun {
  if (!runs.length) return { run: { indices: [], matchedTokens: 0, skipped: 0 }, ambiguous: false };
  const maxTokens = Math.max(...runs.map((r) => r.matchedTokens));
  const tokenTop = runs.filter((r) => r.matchedTokens === maxTokens);
  // À couverture égale, préférer la séquence la plus contiguë. Sans ce
  // critère, une phrase générique pouvait être reconnue comme une sous-suite
  // de mots espacés de plusieurs tokens alors qu'une occurrence exacte existe.
  const minSkipped = Math.min(...tokenTop.map((r) => r.skipped));
  const contiguousTop = tokenTop.filter((r) => r.skipped === minSkipped);
  const maxLen = Math.max(...contiguousTop.map((r) => r.indices.length));
  const top = contiguousTop.filter((r) => r.indices.length === maxLen);
  if (cursor == null) {
    return {
      run: top[0],
      ambiguous: new Set(top.map((r) => r.indices[0])).size > 1,
    };
  }
  let best = top[0];
  let bestDist = Infinity;
  let bestCandidates: CandidateRun[] = [];
  for (const r of top) {
    const d = Math.abs(r.indices[0] - cursor);
    if (d < bestDist) {
      bestDist = d;
      best = r;
      bestCandidates = [r];
    } else if (d === bestDist) {
      bestCandidates.push(r);
    }
  }
  return {
    run: best,
    ambiguous: new Set(bestCandidates.map((r) => r.indices[0])).size > 1,
  };
}

const MAX_INTERLINE_GAP = 80;

// Aligne les lignes d'un chunk avec contrainte de localité.
// Renvoie les indices de docWords retenus.
function alignChunkLines(
  lines: string[][],
  docWords: DocWord[],
  posIndex: Map<string, number[]>,
): { indices: number[]; matchedTokens: number; ambiguous: boolean; coherent: boolean; maxInterlineGap: number } {
  const sequence = lines.flat();
  const exact = exactSequenceRuns(sequence, docWords, posIndex);
  if (exact.length === 1) {
    return {
      indices: exact[0],
      matchedTokens: sequence.length,
      ambiguous: false,
      coherent: true,
      maxInterlineGap: 0,
    };
  }
  // Une séquence exacte répétée est intrinsèquement ambiguë. Ne pas la laisser
  // tomber dans le repli heuristique, qui pourrait choisir une occurrence valide
  // syntaxiquement mais mauvaise sémantiquement.
  if (exact.length > 1) {
    return { indices: [], matchedTokens: 0, ambiguous: true, coherent: false, maxInterlineGap: 0 };
  }

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
  if (seed < 0) return { indices: [], matchedTokens: 0, ambiguous: false, coherent: false, maxInterlineGap: 0 };

  const matched = new Set<number>();
  const selected = new Map<number, CandidateRun>();
  const seedPick = pickRun(perLine[seed], null);
  const seedRun = seedPick.run;
  selected.set(seed, seedRun);
  seedRun.indices.forEach((i) => matched.add(i));
  let matchedTokens = seedRun.matchedTokens;
  let ambiguous = seedPick.ambiguous;
  // Descente puis remontée depuis le seed, curseur propagé pour la localité.
  let cursor: number | null = seedRun.indices.length ? seedRun.indices[seedRun.indices.length - 1] : null;
  for (let li = seed + 1; li < lines.length; li++) {
    const picked = pickRun(candidateRuns(lines[li], docWords, posIndex, matched), cursor);
    const r = picked.run;
    if (r.indices.length) {
      selected.set(li, r);
      r.indices.forEach((i) => matched.add(i));
      matchedTokens += r.matchedTokens;
      cursor = r.indices[r.indices.length - 1];
      ambiguous ||= picked.ambiguous;
    }
  }
  cursor = seedRun.indices.length ? seedRun.indices[0] : null;
  for (let li = seed - 1; li >= 0; li--) {
    const picked = pickRun(candidateRuns(lines[li], docWords, posIndex, matched), cursor);
    const r = picked.run;
    if (r.indices.length) {
      selected.set(li, r);
      r.indices.forEach((i) => matched.add(i));
      matchedTokens += r.matchedTokens;
      cursor = r.indices[0];
      ambiguous ||= picked.ambiguous;
    }
  }

  // Les lignes d'un chunk doivent rester proches dans le flux PDF. On mesure la
  // distance absolue plutôt que d'imposer un ordre strict : les extracteurs PDF
  // peuvent parcourir des colonnes ou des blocs dans un ordre différent de celui
  // d'Albert, sans que les mots soient faux. Cela écarte toutefois les faux
  // positifs où chaque ligne existe, mais à des dizaines de paragraphes/pages
  // différentes. Un vrai saut de page reste accepté ; les en-têtes/pieds de page
  // sont tolérés par la fenêtre.
  let coherent = true;
  let maxInterlineGap = 0;
  // Les chunks longs peuvent traverser des figures, tableaux ou blocs de
  // colonnes absents de la couche texte ; leur fenêtre augmente modérément,
  // tout en conservant la preuve forte « chaque token retrouvé une fois ».
  const maxAllowedInterlineGap = Math.max(MAX_INTERLINE_GAP, sequence.length * 2);
  const orderedLines = [...selected.keys()].sort((a, b) => a - b);
  for (let i = 1; i < orderedLines.length; i++) {
    const previous = selected.get(orderedLines[i - 1])!;
    const current = selected.get(orderedLines[i])!;
    const previousLast = Math.max(...previous.indices);
    const currentFirst = Math.min(...current.indices);
    const gap = currentFirst - previousLast - 1;
    const distance = Math.abs(gap);
    maxInterlineGap = Math.max(maxInterlineGap, distance);
    if (distance > maxAllowedInterlineGap) {
      coherent = false;
      break;
    }
  }
  return { indices: [...matched], matchedTokens, ambiguous, coherent, maxInterlineGap };
}

interface DocIndex {
  docWords: DocWord[];
  dims: Map<number, PageMetrics>;
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

function chunkLines(content: string): string[][] {
  return content
    .split(/\n+/)
    .map((l) => l
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .split(/\s+/)
      .map(normalizeWord)
      .filter(Boolean));
}

type Rect = { x: number; y: number; w: number; h: number };

function pagesFromLines(
  perPage: Map<number, Map<string, Rect>>,
  dims: Map<number, PageMetrics>,
): PageHighlights[] {
  const pages: PageHighlights[] = [];
  for (const [page, pageLines] of [...perPage.entries()].sort((a, b) => a[0] - b[0])) {
    const d = dims.get(page);
    if (!d) continue;
    pages.push({
      page,
      width: d.w,
      height: d.h,
      coordinateSpace: 'pdf-user',
      pdfBounds: d.pdfBounds,
      rects: [...pageLines.values()],
    });
  }
  return pages;
}

function alignOneChunk(
  docIndex: DocIndex,
  ch: { id?: string; content: string },
): ChunkHighlightAnchor {
  const lines = chunkLines(ch.content);
  const wordCount = lines.reduce((s, l) => s + l.length, 0);
  const aligned = alignChunkLines(lines, docIndex.docWords, docIndex.posIndex);
  const matched = [...new Set(aligned.indices)].sort((a, b) => a - b);
  const perPage = new Map<number, Map<string, Rect>>();

  let previous: { di: number; page: number; line: number; key: string; rect: Rect } | null = null;
  for (const di of matched) {
    const wd = docIndex.docWords[di];
    let pageLines = perPage.get(wd.page);
    if (!pageLines) { pageLines = new Map(); perPage.set(wd.page, pageLines); }
    const box = { x: wd.x, y: wd.y, w: wd.w, h: wd.h };
    // Fusionne uniquement les mots PDF réellement consécutifs du même bloc.
    // Si l'algorithme a dû sauter un mot pour tolérer une différence OCR, ce
    // mot reste hors du rectangle : aucune zone intermédiaire n'est inventée.
    if (previous && previous.di + 1 === di && previous.page === wd.page && previous.line === wd.line) {
      const cur: Rect = previous.rect;
      const nx = Math.min(cur.x, box.x), ny = Math.min(cur.y, box.y);
      const merged: Rect = {
        x: nx, y: ny,
        w: Math.max(cur.x + cur.w, box.x + box.w) - nx,
        h: Math.max(cur.y + cur.h, box.y + box.h) - ny,
      };
      pageLines.delete(previous.key);
      pageLines.set(previous.key, merged);
      previous = { di, page: wd.page, line: wd.line, key: previous.key, rect: merged };
    } else {
      const key: string = `${wd.line}:${di}`;
      pageLines.set(key, box);
      previous = { di, page: wd.page, line: wd.line, key, rect: box };
    }
  }

  // Une césure PDF peut transformer un mot du chunk en deux mots visuels.
  // Le compteur de tokens distingue une césure PDF (un token du chunk devient
  // deux mots visuels) d'un mot réellement absent. Un chunk incomplet reste
  // strictement non vérifié.
  // `matchedTokens` seul ne suffit pas : deux lignes répétées pourraient être
  // rabattues sur les mêmes mots PDF. Il faut aussi au moins un mot PDF
  // distinct par token du chunk (les césures peuvent en produire davantage).
  const verified =
    wordCount > 0 &&
    aligned.matchedTokens === wordCount &&
    matched.length >= wordCount &&
    !aligned.ambiguous &&
    aligned.coherent;
  const verificationReason = wordCount === 0
    ? 'empty'
    : aligned.ambiguous
      ? 'ambiguous'
      : !aligned.coherent
        ? 'incoherent'
        : aligned.matchedTokens !== wordCount
          ? 'missing'
          : matched.length < wordCount
            ? 'duplicate-reuse'
            : 'verified';
  return {
    id: ch.id,
    words: wordCount,
    matched: matched.length,
    matchedTokens: aligned.matchedTokens,
    // Les coordonnées d'un chunk non vérifié ne sortent pas de cette fonction :
    // elles restent utiles au diagnostic seulement si la correspondance est
    // prouvée. La route et la base n'ont ainsi aucune chance de les servir par
    // inadvertance dans une future évolution.
    pages: verified ? pagesFromLines(perPage, docIndex.dims) : [],
    verified,
    verificationReason,
    maxInterlineGap: aligned.maxInterlineGap,
  };
}

// Prépare les coordonnées au moment de l'ingestion. Le résultat est ensuite
// persisté côté application et réutilisé par la visionneuse : aucune recherche
// approximative n'est effectuée à l'ouverture du PDF.
export function computeChunkAnchors(
  pdfBytes: Uint8Array,
  chunks: Array<{ id?: string; content: string }>,
  cacheKey?: string,
): ChunkAnchorResult {
  const docIndex = getDocIndex(pdfBytes, cacheKey);
  const anchors = chunks.map((ch) => alignOneChunk(docIndex, ch));
  return {
    anchors,
    complete: anchors.length > 0 && anchors.every((a) => a.verified),
  };
}

// Point d'entrée : calcule les zones de surlignage par alignement pour des chunks.
// `cacheKey` (ex. clé S3 du PDF) active le cache du texte structuré.
export function computeAlignedHighlights(
  pdfBytes: Uint8Array,
  chunks: Array<{ id?: string; content: string }>,
  cacheKey?: string,
): AlignResult {
  const indexed = computeChunkAnchors(pdfBytes, chunks, cacheKey);
  const perPage = new Map<number, Map<string, Rect>>();
  const report: ChunkAlign[] = [];

  // Cette API historique est également fail-closed : un chunk non vérifié ne
  // doit pas produire de faux rectangles. La route de production utilise les
  // ancres persistées, mais ce garde évite qu'un futur appelant réintroduise le
  // comportement approximatif via cette fonction.
  for (const anchor of indexed.anchors) {
    report.push({ id: anchor.id, words: anchor.words, matched: anchor.matched, matchedTokens: anchor.matchedTokens });
    if (!anchor.verified) continue;
    for (const page of anchor.pages) {
      let rects = perPage.get(page.page);
      if (!rects) { rects = new Map(); perPage.set(page.page, rects); }
      for (const rect of page.rects) {
        const key = `${rect.x}|${rect.y}|${rect.w}|${rect.h}`;
        rects.set(key, rect);
      }
    }
  }

  const pages: PageHighlights[] = [];
  for (const [page, rects] of [...perPage.entries()].sort((a, b) => a[0] - b[0])) {
    // Les dimensions sont identiques pour toutes les ancres d'une page ; la
    // première occurrence suffit ici.
    const source = indexed.anchors.flatMap((a) => a.pages).find((p) => p.page === page);
    pages.push({
      page,
      width: source?.width ?? 0,
      height: source?.height ?? 0,
      coordinateSpace: source?.coordinateSpace,
      pdfBounds: source?.pdfBounds,
      rects: [...rects.values()],
    });
  }
  return { pages, report };
}
