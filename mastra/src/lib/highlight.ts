// mastra/src/lib/highlight.ts
import * as mupdf from 'mupdf';
import { rectFromQuad } from './highlight-text.js';

export interface PageHighlights {
  page: number;
  width: number;
  height: number;
  rects: { x: number; y: number; w: number; h: number }[];
  // Les ancres persistées par highlight-align sont en coordonnées PDF user
  // space. Les anciennes fonctions de recherche à la volée restent en
  // coordonnées MuPDF top-left et ne sont pas servies par la visionneuse.
  coordinateSpace?: 'pdf-user' | 'mupdf-top-left';
  pdfBounds?: [number, number, number, number];
}

// Rapport de diagnostic par phrase : où (quelles pages) et combien de fois chaque
// phrase a été trouvée. Sert au mode debug pour comprendre "à moitié" (taux de match)
// et "zones sans rapport" (phrase trouvée sur plusieurs pages).
export interface PhraseReport {
  phrase: string;
  pages: { page: number; matches: number }[];
  totalMatches: number;
}

export interface HighlightResult {
  pages: PageHighlights[];
  report: PhraseReport[];
}

// Cœur : localise chaque phrase dans le PDF ET produit le rapport par phrase.
// mupdf : page.search -> QuadPoint[][] ; getBounds -> [ulx,uly,lrx,lry] (origine
// haut-gauche). Best-effort : une phrase introuvable est simplement ignorée.
export function computeHighlightsDiag(pdfBytes: Uint8Array, phrases: string[]): HighlightResult {
  const doc = mupdf.PDFDocument.openDocument(pdfBytes, 'application/pdf');
  try {
    const out: PageHighlights[] = [];
    const report: PhraseReport[] = phrases.map((phrase) => ({ phrase, pages: [], totalMatches: 0 }));
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      try {
        const b = page.getBounds();
        const width = b[2] - b[0];
        const height = b[3] - b[1];
        const rects: { x: number; y: number; w: number; h: number }[] = [];
        phrases.forEach((phrase, pi) => {
          let results: number[][][] = [];
          try {
            results = page.search(phrase) as unknown as number[][][];
          } catch {
            results = [];
          }
          if (results.length) {
            report[pi].pages.push({ page: i + 1, matches: results.length });
            report[pi].totalMatches += results.length;
          }
          for (const quads of results) {
            for (const quad of quads) rects.push(rectFromQuad(quad));
          }
        });
        if (rects.length) out.push({ page: i + 1, width, height, rects });
      } finally {
        page.destroy();
      }
    }
    return { pages: out, report };
  } finally {
    doc.destroy();
  }
}

// API publique inchangée : ne renvoie que les zones de surlignage.
export function computeHighlights(pdfBytes: Uint8Array, phrases: string[]): PageHighlights[] {
  return computeHighlightsDiag(pdfBytes, phrases).pages;
}
