// mastra/src/lib/highlight.ts
import * as mupdf from 'mupdf';
import { rectFromQuad } from './highlight-text.js';

export interface PageHighlights {
  page: number;
  width: number;
  height: number;
  rects: { x: number; y: number; w: number; h: number }[];
}

// Localise chaque phrase dans le PDF. mupdf : page.search -> QuadPoint[][] ;
// getBounds -> [ulx,uly,lrx,lry] (origine haut-gauche). Best-effort : une phrase
// introuvable est simplement ignorée (repli sans surlignage côté client).
export function computeHighlights(pdfBytes: Uint8Array, phrases: string[]): PageHighlights[] {
  const doc = mupdf.PDFDocument.openDocument(pdfBytes, 'application/pdf');
  try {
    const out: PageHighlights[] = [];
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      try {
        const b = page.getBounds();
        const width = b[2] - b[0];
        const height = b[3] - b[1];
        const rects: { x: number; y: number; w: number; h: number }[] = [];
        for (const phrase of phrases) {
          let results: number[][][] = [];
          try {
            results = page.search(phrase) as unknown as number[][][];
          } catch {
            results = [];
          }
          for (const quads of results) {
            for (const quad of quads) rects.push(rectFromQuad(quad));
          }
        }
        if (rects.length) out.push({ page: i + 1, width, height, rects });
      } finally {
        page.destroy();
      }
    }
    return out;
  } finally {
    doc.destroy();
  }
}
