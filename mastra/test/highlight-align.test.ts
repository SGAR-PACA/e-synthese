import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlignedHighlights, normalizeWord } from '../src/lib/highlight-align.js';

function buildPdf(pages: string[][]): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${3 + i} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  const fontObj = 3 + pages.length;
  pages.forEach((_l, pi) => {
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
  for (let i = 1; i < objects.length; i++) { off[i] = pdf.length; pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xs = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xs}\n%%EOF`;
  return new Uint8Array(new TextEncoder().encode(pdf));
}

test('normalizeWord : minuscule, sans accent, sans Markdown', () => {
  assert.equal(normalizeWord('**Économique,**'), 'economique');
  assert.equal(normalizeWord('# Préfecture'), 'prefecture');
  assert.equal(normalizeWord('|'), '');
});

test('computeAlignedHighlights : chunk Markdown aligné sur PDF brut', () => {
  const pdf = buildPdf([['Le present rapport analyse la situation', 'economique et propose des mesures concretes.']]);
  // Le contenu du chunk est décoré en Markdown (titres, gras) ; le PDF est brut.
  const chunk = '## **Le present rapport** analyse la situation economique et propose des **mesures concretes**.';
  const { pages, report } = computeAlignedHighlights(pdf, [{ id: 'c1', content: chunk }]);
  const cov = report[0].matched / report[0].words;
  assert.ok(cov >= 0.9, `couverture ${Math.round(cov * 100)}% attendue >= 90%`);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].page, 1);
  assert.ok(pages[0].rects.length >= 1);
});

test('computeAlignedHighlights : cache par cacheKey donne un résultat identique', () => {
  const pdf = buildPdf([['Le present rapport analyse la situation economique du pays.']]);
  const chunk = [{ id: 'c1', content: 'Le present rapport analyse la situation economique du pays.' }];
  const first = computeAlignedHighlights(pdf, chunk, 'doc-key');
  const second = computeAlignedHighlights(pdf, chunk, 'doc-key'); // devrait servir le cache
  assert.deepEqual(second.pages, first.pages);
  assert.deepEqual(second.report, first.report);
});

test('computeAlignedHighlights : chunk ENTIER surligné (table Markdown incluse), pas un sous-ensemble', () => {
  const pdf = buildPdf([
    ['La demande economique de la region continue'],
    ['Tableau 68 858 790 fermetures par departement'],
    ['Nous navons aucun element supplementaire disponible'],
  ]);
  const chunk = [{
    id: 'c1',
    content:
      '## La demande economique de la region continue\n' +
      '| Tableau | 68 | 858 | 790 | fermetures par departement |\n' +
      'Nous navons aucun element supplementaire disponible',
  }];
  // Tout le chunk s'aligne -> les 3 pages (prose + tableau + prose) sont surlignées.
  const { pages } = computeAlignedHighlights(pdf, chunk);
  assert.deepEqual(pages.map((p) => p.page), [1, 2, 3], 'chunk entier = 3 pages, y compris la ligne de tableau');
});

test('computeAlignedHighlights : césure — un mot coupé en fin de ligne est réaligné', () => {
  // mupdf lit « anticonstitution- » et « nellement » comme 2 tokens sur 2 lignes.
  // Le chunk (linéarisé par Albert) contient le mot entier. Sans gestion de la
  // césure, ce mot ne matche NI l'un NI l'autre fragment.
  const pdf = buildPdf([['Le mot anticonstitution-', 'nellement termine la phrase']]);
  const chunk = 'Le mot anticonstitutionnellement termine la phrase';
  const { pages, report } = computeAlignedHighlights(pdf, [{ id: 'c1', content: chunk }]);
  const cov = report[0].matched / report[0].words;
  assert.ok(cov >= 0.95, `couverture ${Math.round(cov * 100)}% attendue >= 95% (mot coupé recollé)`);
  assert.ok(pages.length >= 1 && pages[0].rects.length >= 1);
});

test('computeAlignedHighlights : pas de parasite sur phrase répétée', () => {
  const repeated = 'La performance est en hausse cette annee.';
  const pdf = buildPdf([[repeated], ['Contexte du chunk en page deux ici.', repeated], [repeated]]);
  // Le chunk vit en page 2 ; sa 2e LIGNE se répète en pages 1 et 3.
  // La localité doit la rattacher à la page 2 (proche de la 1re ligne), pas ailleurs.
  const chunk = 'Contexte du chunk en page deux ici.\n' + repeated;
  const { pages } = computeAlignedHighlights(pdf, [{ id: 'c1', content: chunk }]);
  assert.deepEqual(pages.map((p) => p.page), [2], 'surlignage limité à la page 2 (aucun parasite)');
});
