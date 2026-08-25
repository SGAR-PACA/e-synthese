import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlignedHighlights, computeChunkAnchors, normalizeWord } from '../src/lib/highlight-align.js';
import { buildTextChunksFromPages, extractPdfTextPages } from '../src/lib/pdf-text.js';

function buildPdf(
  pages: string[][],
  rotate = 0,
  crop: [number, number, number, number] = [0, 0, 400, 300],
): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = pages.map((_, i) => `${3 + i} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  const fontObj = 3 + pages.length;
  pages.forEach((_l, pi) => {
    objects[3 + pi] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 400] /CropBox [${crop.join(' ')}] /Rotate ${rotate} ` +
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
  assert.equal(normalizeWord('œuvre Æther'), 'oeuvreaether');
  assert.equal(normalizeWord('|'), '');
});

test('extractPdfTextPages : conserve les lignes dans l’ordre et les valeurs répétées', () => {
  const pdf = buildPdf([
    ['En-tete du tableau', 'Dpt 04', '7', '15', 'TOTAL REGION 6221'],
  ]);
  const pages = extractPdfTextPages(pdf);
  assert.deepEqual(pages, [{
    page: 1,
    lines: ['En-tete du tableau', 'Dpt 04', '7', '15', 'TOTAL REGION 6221'],
  }]);
});

test('buildTextChunksFromPages : découpage déterministe sans perte de texte', () => {
  const longLine = 'A'.repeat(230);
  const pages = [
    { page: 1, lines: ['Titre', longLine, 'Dpt 04', '7', '15', 'TOTAL REGION 6221'] },
    { page: 2, lines: ['Même ligne répétée', 'Même ligne répétée'] },
  ];
  const first = buildTextChunksFromPages(pages, 256);
  const second = buildTextChunksFromPages(pages, 256);
  assert.deepEqual(second, first);
  assert.equal(first.map((chunk) => chunk.content).join('\n'), pages.flatMap((p) => p.lines).join('\n'));
  assert.ok(first.some((chunk) => chunk.content.includes('TOTAL REGION 6221')));
  const last = first.at(-1)!;
  assert.ok(last.content.endsWith('Même ligne répétée\nMême ligne répétée'));
  assert.equal(last.pageEnd, 2);
});

test('buildTextChunksFromPages : le défaut garde les lignes numériques dans leur contexte', () => {
  const pages = [{
    page: 1,
    lines: ['A'.repeat(1785), '280 116', '0', '0', '280 116', '280 116'],
  }];
  const legacy = buildTextChunksFromPages(pages, 1800);
  const current = buildTextChunksFromPages(pages);

  assert.equal(legacy.length, 2, 'l’ancien seuil isolait la fin numérique');
  assert.equal(current.length, 1, 'le seuil validé conserve le contexte du tableau');
  assert.ok(current[0].content.endsWith('280 116\n0\n0\n280 116\n280 116'));
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

test('computeChunkAnchors : un chunk entièrement retrouvé est vérifié', () => {
  const pdf = buildPdf([['Le passage complet est retrouve sans ambiguite.']]);
  const result = computeChunkAnchors(pdf, [{ id: 'c1', content: 'Le passage complet est retrouve sans ambiguite.' }]);
  assert.equal(result.complete, true);
  assert.equal(result.anchors.length, 1);
  assert.equal(result.anchors[0].verified, true);
  assert.ok(result.anchors[0].pages[0].rects.length > 0);
  assert.equal(result.anchors[0].pages[0].coordinateSpace, 'pdf-user');
  assert.deepEqual(result.anchors[0].pages[0].pdfBounds, [0, 0, 400, 300]);
});

test('computeChunkAnchors : un chunk partiellement retrouvé est refusé', () => {
  const pdf = buildPdf([['Seule cette phrase est présente.']]);
  const result = computeChunkAnchors(pdf, [{ id: 'c1', content: 'Seule cette phrase est présente mais ce texte manque.' }]);
  assert.equal(result.complete, false);
  assert.equal(result.anchors[0].verified, false);
});

test('computeChunkAnchors : deux lignes identiques ne peuvent pas réutiliser le même mot PDF', () => {
  const pdf = buildPdf([['Une seule occurrence est disponible.']]);
  const result = computeChunkAnchors(pdf, [{
    id: 'c1',
    content: 'Une seule occurrence est disponible.\nUne seule occurrence est disponible.',
  }]);
  assert.equal(result.complete, false);
  assert.equal(result.anchors[0].verified, false);
});

test('computeChunkAnchors : une séquence exacte répétée est refusée comme ambiguë', () => {
  const repeated = 'Une phrase strictement identique est ici.';
  const pdf = buildPdf([[repeated], [repeated]]);
  const result = computeChunkAnchors(pdf, [{ id: 'c1', content: repeated }]);
  assert.equal(result.complete, false);
  assert.equal(result.anchors[0].verified, false);
  assert.equal(result.anchors[0].pages.length, 0, 'aucune occurrence arbitraire ne doit être servie');
});

test('computeChunkAnchors : des lignes éloignées ne forment pas un chunk vérifié', () => {
  const fillerLines = Array.from({ length: 20 }, (_, i) =>
    `mot${i * 5} mot${i * 5 + 1} mot${i * 5 + 2} mot${i * 5 + 3} mot${i * 5 + 4}`,
  );
  const pdf = buildPdf([[
    'Premiere ligne du passage.',
    ...fillerLines,
    'Derniere ligne du passage.',
  ]]);
  const result = computeChunkAnchors(pdf, [{
    id: 'c1',
    content: 'Premiere ligne du passage.\nDerniere ligne du passage.',
  }]);
  assert.equal(result.complete, false);
  assert.equal(result.anchors[0].verified, false);
});

test('computeChunkAnchors : les coordonnées restent dans l’espace PDF malgré la rotation d’affichage', () => {
  const pdf = buildPdf([['Une page tournee reste alignable.']], 90);
  const result = computeChunkAnchors(pdf, [{ id: 'c1', content: 'Une page tournee reste alignable.' }]);
  const page = result.anchors[0].pages[0];
  assert.equal(result.anchors[0].verified, true);
  assert.equal(page.coordinateSpace, 'pdf-user');
  // Les dimensions sont celles de la MediaBox (espace PDF), pas celles du
  // viewport tourné affiché par PDF.js.
  assert.deepEqual(page.pdfBounds, [0, 0, 400, 300]);
  assert.equal(page.width, 400);
  assert.equal(page.height, 300);
});

test('computeChunkAnchors : un CropBox décalé reste aligné dans l’espace PDF', () => {
  const pdf = buildPdf([['Le texte reste dans la zone visible.']], 0, [10, 20, 410, 320]);
  const result = computeChunkAnchors(pdf, [{ id: 'c1', content: 'Le texte reste dans la zone visible.' }]);
  const page = result.anchors[0].pages[0];
  assert.equal(result.anchors[0].verified, true);
  assert.deepEqual(page.pdfBounds, [10, 20, 410, 320]);
  assert.ok(page.rects[0].x >= 10 && page.rects[0].x < 410);
  assert.ok(page.rects[0].y >= 20 && page.rects[0].y < 320);
});
