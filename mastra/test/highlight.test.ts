import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeHighlightsDiag } from '../src/lib/highlight.js';

// Construit un PDF multi-pages minimal (une ligne de texte par page).
function buildPdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${3 + i} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  const fontObj = 3 + pages.length;
  pages.forEach((_lines, pi) => {
    objects[3 + pi] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${fontObj + 1 + pi} 0 R >>`;
  });
  objects[fontObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((lines, pi) => {
    let content = 'BT /F1 12 Tf 40 260 Td (' + lines[0] + ') Tj';
    for (let i = 1; i < lines.length; i++) content += ` 0 -18 Td (${lines[i]}) Tj`;
    content += ' ET';
    objects[fontObj + 1 + pi] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let pdf = '%PDF-1.4\n';
  const off: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    off[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xs = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xs}\n%%EOF`;
  return new Uint8Array(new TextEncoder().encode(pdf));
}

test('computeHighlightsDiag : rapporte phrase trouvée vs ratée', () => {
  const pdf = buildPdf([['La phrase presente dans le document ici.']]);
  const { report } = computeHighlightsDiag(pdf, [
    'La phrase presente dans le document ici.',
    'Une phrase totalement absente du document.',
  ]);
  const found = report.find((r) => r.phrase.startsWith('La phrase presente'))!;
  const miss = report.find((r) => r.phrase.startsWith('Une phrase totalement'))!;
  assert.equal(found.totalMatches, 1);
  assert.deepEqual(found.pages, [{ page: 1, matches: 1 }]);
  assert.equal(miss.totalMatches, 0);
  assert.deepEqual(miss.pages, []);
});

test('computeHighlightsDiag : détecte une phrase répétée sur plusieurs pages (parasite)', () => {
  const repeated = 'La performance est en hausse cette annee.';
  const pdf = buildPdf([[repeated], ['Contexte du chunk en page deux.', repeated], [repeated]]);
  const { report } = computeHighlightsDiag(pdf, [repeated]);
  const r = report[0];
  assert.equal(r.pages.length, 3, 'la phrase répétée matche sur les 3 pages');
  assert.equal(r.totalMatches, 3);
});
