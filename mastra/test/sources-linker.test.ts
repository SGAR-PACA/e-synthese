// mastra/test/sources-linker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcesBlock, ensureSourcesBlock, findSourcesBlockStart, injectSourceLinks } from '../src/lib/sources-linker.js';
import type { RagChunk } from '../src/lib/db.js';

const sign = (documentId: string, chunkIds: string[]) => `used=${chunkIds.join(',')}&sig=X`;
const chunk = (over: Partial<RagChunk>): RagChunk => ({ name: 'A.pdf', content: '', score: 1, url: '', ...over });

test('réécrit une source italique en lien visionneuse', () => {
  const answer = 'Texte.\n\n**Sources :**\n- Source 1 : *A.pdf*';
  const out = injectSourceLinks(answer, [chunk({ name: 'A.pdf', documentId: 'doc-7', chunkId: 'c1' })], sign);
  assert.match(out, /- Source 1 : \[A\.pdf\]\(\/v1\/source\/doc-7\?used=c1&sig=X\)/);
});

test('aucun param &a= dans le lien (surlignage = chunk entier, plus de restriction mot-à-mot)', () => {
  const answer = 'La region prevoit 68 fermetures.\n\n**Sources :**\n- Source 1 : *A.pdf*';
  const out = injectSourceLinks(answer, [chunk({ documentId: 'doc-7', chunkId: 'c1' })], sign);
  assert.ok(!/&a=/.test(out), 'plus de param a : le surlignage couvre tout le chunk');
});

test('regroupe plusieurs chunkIds du même document', () => {
  const answer = '**Sources :**\n- Source 1 : *A.pdf*';
  const chunks = [
    chunk({ name: 'A.pdf', documentId: 'doc-7', chunkId: 'c1' }),
    chunk({ name: 'A.pdf', documentId: 'doc-7', chunkId: 'c2' }),
  ];
  const out = injectSourceLinks(answer, chunks, sign);
  assert.match(out, /\?used=c1,c2&sig=X/);
});

test('laisse intacte une source sans documentId connu', () => {
  const answer = '**Sources :**\n- Source 1 : *Inconnu.pdf*';
  const out = injectSourceLinks(answer, [chunk({ name: 'A.pdf', documentId: 'doc-7' })], sign);
  assert.equal(out, answer);
});

test('ne touche pas le corps de la réponse', () => {
  const answer = 'Un paragraphe avec *italique*.\n\n**Sources :**\n- Source 1 : *A.pdf*';
  const out = injectSourceLinks(answer, [chunk({ documentId: 'doc-7', chunkId: 'c1' })], sign);
  assert.match(out, /Un paragraphe avec \*italique\*\./);
});

test('échappe les crochets du nom', () => {
  const answer = '**Sources :**\n- Source 1 : *A [2025].pdf*';
  const out = injectSourceLinks(answer, [chunk({ name: 'A [2025].pdf', documentId: 'doc-7', chunkId: 'c1' })], sign);
  assert.match(out, /\[A \\\[2025\\\]\.pdf\]/);
});

test('réécrit aussi une source déjà en lien [nom](url) (URL Albert) en lien signé', () => {
  const answer = '**Sources :**\n- Source 1 : [A.pdf](https://x/y)';
  const out = injectSourceLinks(answer, [chunk({ name: 'A.pdf', documentId: 'doc-7', chunkId: 'c1' })], sign);
  assert.match(out, /- Source 1 : \[A\.pdf\]\(\/v1\/source\/doc-7\?used=c1&sig=X\)/);
});

test('collision de noms : deux chunks de documents différents → lien vers le premier doc uniquement', () => {
  const answer = '**Sources :**\n- Source 1 : *A.pdf*';
  const chunks: RagChunk[] = [
    chunk({ name: 'A.pdf', documentId: 'doc-1', chunkId: 'c1' }),
    chunk({ name: 'A.pdf', documentId: 'doc-2', chunkId: 'c2' }),
  ];
  const out = injectSourceLinks(answer, chunks, sign);
  // Le lien doit pointer vers doc-1 avec used=c1 uniquement (pas c2)
  assert.match(out, /\/v1\/source\/doc-1\?used=c1&sig=X/);
  assert.doesNotMatch(out, /doc-2/);
  assert.doesNotMatch(out, /c2/);
});

// --- Noms recopiés par l'IA avec des variations invisibles (cas réels du banc de 50 questions) ---
const linked = (line: string, name: string) =>
  injectSourceLinks(`**Sources :**\n${line}`, [chunk({ name, documentId: 'doc-7', chunkId: 'c1' })], sign);
const assertLinked = (out: string) => assert.match(out, /\]\(\/v1\/source\/doc-7\?used=c1&sig=X\)/);

test('nom du fichier en NFD (macOS) et nom écrit par l\'IA en NFC → lien', () => {
  const nfd = 'Exemple ventilation crédits pré-CAR B000.pdf'.normalize('NFD');
  const out = linked('- Source 1 : *Exemple ventilation crédits pré-CAR B000.pdf*'.normalize('NFC'), nfd);
  assertLinked(out);
});

test('le texte du lien est le vrai nom du fichier, pas la variante écrite par l\'IA', () => {
  const out = linked('- Source 1 : *Note pré‑CAR.pdf*', 'Note pré-CAR.pdf');
  assert.match(out, /- Source 1 : \[Note pré-CAR\.pdf\]\(/);
});

for (const [label, dash] of [
  ['U+2010', '‐'], ['U+2011 (vu G48)', '‑'], ['U+2012', '‒'], ['U+2013', '–'],
  ['U+2014', '—'], ['U+2015', '―'], ['U+2212', '−'], ['U+FE63', '﹣'], ['U+FF0D', '－'],
]) {
  test(`tiret ${label} à la place de "-" → lien`, () => {
    assertLinked(linked(`- Source 1 : *2000_01_01_Note pré${dash}exemple${dash}thématique.pdf*`, '2000_01_01_Note pré-exemple-thématique.pdf'));
  });
}

for (const [label, invisible] of [
  ['U+200B (vu Q3)', '​'], ['U+200C', '‌'], ['U+200D', '‍'], ['U+2060', '⁠'], ['U+FEFF', '﻿'], ['U+00AD', '­'],
]) {
  test(`caractère invisible ${label} dans le nom → lien`, () => {
    assertLinked(linked(`- Source 1 : *Note cré${invisible}dits.pdf*`, 'Note crédits.pdf'));
  });
}

for (const [label, space] of [['U+00A0', ' '], ['U+202F', ' '], ['double espace', '  ']]) {
  test(`espace ${label} dans le nom → lien`, () => {
    assertLinked(linked(`- Source 1 : *Note${space}exemple REGION 2025-1.pdf*`, 'Note exemple REGION 2025-1.pdf'));
  });
}

for (const [label, quote] of [['U+2019', '’'], ['U+2018', '‘'], ['U+02BC', 'ʼ']]) {
  test(`apostrophe ${label} à la place de "'" → lien`, () => {
    assertLinked(linked(`- Source 1 : *note de l${quote}exemple fictif.pdf*`, "note de l'exemple fictif.pdf"));
  });
}

test('underscores échappés en Markdown (\\_) → lien', () => {
  assertLinked(linked('- Source 1 : *2000\\_01\\_01\\_note-exemple.pdf*', '2000_01_01_note-exemple.pdf'));
});

test('texte après le nom en italique « (déjà cité) » (vu G42) → lien, texte conservé', () => {
  const out = linked('- Source 3 : *Programme 2000.pdf* (déjà cité)', 'Programme 2000.pdf');
  assertLinked(out);
  assert.match(out, /\) \(déjà cité\)$/);
});

for (const [label, line] of [
  ['puce "*"', '* Source 1 : *A.pdf*'],
  ['puce "•"', '• Source 1 : *A.pdf*'],
  ['liste numérotée "1."', '1. Source 1 : *A.pdf*'],
  ['nom en gras', '- Source 1 : **A.pdf**'],
  ['nom sans mise en forme', '- Source 1 : A.pdf'],
  ['sans espace avant les deux-points', '- Source 1: *A.pdf*'],
]) {
  test(`forme de ligne : ${label} → lien`, () => {
    assertLinked(linked(line, 'A.pdf'));
  });
}

test('forme de ligne : italique en underscores sur un nom qui en contient → lien', () => {
  assertLinked(linked('- Source 1 : _2000_01_01_note-exemple.pdf_', '2000_01_01_note-exemple.pdf'));
});

test('nom sans mise en forme suivi de « (déjà cité) » → lien, texte conservé', () => {
  const out = linked('- Source 3 : Programme 2000.pdf (déjà cité)', 'Programme 2000.pdf');
  assertLinked(out);
  assert.match(out, /\) \(déjà cité\)$/);
});

test('nom sans mise en forme contenant des parenthèses → lien sur le nom complet', () => {
  const out = linked('- Source 1 : Note (V2).pdf', 'Note (V2).pdf');
  assert.match(out, /\[Note \(V2\)\.pdf\]\(\/v1\/source\/doc-7/);
});

test('pas de faux lien : nom absent des documents fournis même après normalisation', () => {
  const answer = '**Sources :**\n- Source 1 : *Note pré‑CAR V2.pdf*';
  const out = injectSourceLinks(answer, [chunk({ name: 'Note pré-CAR.pdf', documentId: 'doc-7', chunkId: 'c1' })], sign);
  assert.equal(out, answer);
});

test('noms proches : chaque ligne pointe vers son propre document', () => {
  const answer = '**Sources :**\n- Source 1 : *Note‑V2.pdf*\n- Source 2 : *Note.pdf*';
  const out = injectSourceLinks(answer, [
    chunk({ name: 'Note.pdf', documentId: 'doc-1', chunkId: 'c1' }),
    chunk({ name: 'Note-V2.pdf', documentId: 'doc-2', chunkId: 'c2' }),
  ], sign);
  assert.match(out, /Source 1 : \[Note-V2\.pdf\]\(\/v1\/source\/doc-2\?used=c2/);
  assert.match(out, /Source 2 : \[Note\.pdf\]\(\/v1\/source\/doc-1\?used=c1/);
});

test('filet sources : ajoute les documents dédupliqués si le modèle oublie le bloc', () => {
  const chunks = [
    { name: 'A.pdf', content: 'a' },
    { name: 'A.pdf', content: 'b' },
    { name: 'B.pdf', content: 'c' },
  ];
  assert.equal(
    ensureSourcesBlock('Réponse documentée.', chunks),
    'Réponse documentée.\n\n**Sources :**\n- Source 1 : *A.pdf*\n- Source 2 : *B.pdf*',
  );
});

for (const [label, answer] of [
  ['gras sans deux-points', 'Réponse.\n\n**Sources**\n- Source 1 : *A.pdf*'],
  ['un seul saut de ligne', 'Réponse.\n**Sources :**\n- Source 1 : *A.pdf*'],
  ['sans gras', 'Réponse.\n\nSources :\n- Source 1 : *A.pdf*'],
  ['titre Markdown', 'Réponse.\n\n### Sources\n- Source 1 : *A.pdf*'],
]) {
  test(`filet sources : en-tête « ${label} » reconnu, pas de bloc en double`, () => {
    assert.equal(ensureSourcesBlock(answer, [{ name: 'A.pdf', content: 'a' }]), answer);
  });
}

test('findSourcesBlockStart : repère l\'en-tête, ignore « **Sources officielles** » dans le corps', () => {
  const body = 'Intro.\n**Sources officielles** nombreuses.';
  assert.equal(findSourcesBlockStart(body), -1);
  const text = `${body}\n\nSources :\n- Source 1 : *A.pdf*`;
  assert.equal(text.slice(findSourcesBlockStart(text)).trimStart().startsWith('Sources :'), true);
});

test('filet sources : conserve sans doublon un bloc déjà produit par le modèle', () => {
  const answer = 'Réponse.\n\n**Sources :**\n- Source 1 : *A.pdf*';
  assert.equal(ensureSourcesBlock(answer, [{ name: 'A.pdf', content: 'a' }]), answer);
});

test('filet sources : aucun chunk ne fabrique une source artificielle', () => {
  assert.equal(buildSourcesBlock([]), '');
  assert.equal(ensureSourcesBlock('Réponse directe.', []), 'Réponse directe.');
});
