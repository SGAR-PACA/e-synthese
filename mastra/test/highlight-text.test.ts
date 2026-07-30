import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsedParam, splitIntoSearchPhrases, rectFromQuad } from '../src/lib/highlight-text.js';

test('parseUsedParam : liste valide', () => {
  assert.deepEqual(parseUsedParam('c1,c2,c3'), ['c1', 'c2', 'c3']);
});

test('parseUsedParam : filtre les ids invalides', () => {
  assert.deepEqual(parseUsedParam('c1, bad id ,c2'), ['c1', 'c2']);
});

test('parseUsedParam : vide -> []', () => {
  assert.deepEqual(parseUsedParam(undefined), []);
});

test('splitIntoSearchPhrases : découpe et filtre les courts', () => {
  const phrases = splitIntoSearchPhrases('Une phrase assez longue ici. Court.\nAutre phrase longue à chercher.');
  assert.ok(phrases.includes('Une phrase assez longue ici.'));
  assert.ok(phrases.includes('Autre phrase longue à chercher.'));
  assert.ok(!phrases.includes('Court.'));
});

test('splitIntoSearchPhrases : retire titres et gras Markdown', () => {
  const phrases = splitIntoSearchPhrases('# **Titre important du document**');
  assert.deepEqual(phrases, ['Titre important du document']);
});

test('splitIntoSearchPhrases : lien Markdown -> texte visible', () => {
  const phrases = splitIntoSearchPhrases('[gourdontom@hotmail.fr](mailto:gourdontom@hotmail.fr)');
  assert.ok(phrases.includes('gourdontom@hotmail.fr'));
});

test('splitIntoSearchPhrases : découpe les cellules de tableau', () => {
  const phrases = splitIntoSearchPhrases('**Préfecture région PACA** | Marseille le 14 mai');
  assert.ok(phrases.includes('Préfecture région PACA'));
  assert.ok(phrases.includes('Marseille le 14 mai'));
});

test('splitIntoSearchPhrases : ignore un mot isolé générique (<20 car.)', () => {
  // "expérimentation" seul (15 car., 1 mot) causait des surlignages parasites.
  assert.deepEqual(splitIntoSearchPhrases('expérimentation'), []);
});

test('splitIntoSearchPhrases : normalise l espace avant ponctuation', () => {
  const phrases = splitIntoSearchPhrases('un evenement en **avril 2025** .');
  assert.ok(phrases.includes('un evenement en avril 2025.'));
});

test('rectFromQuad : enveloppe correcte', () => {
  // ulx,uly,urx,ury,llx,lly,lrx,lry
  const r = rectFromQuad([10, 20, 50, 20, 10, 35, 50, 35]);
  assert.deepEqual(r, { x: 10, y: 20, w: 40, h: 15 });
});
