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

test('rectFromQuad : enveloppe correcte', () => {
  // ulx,uly,urx,ury,llx,lly,lrx,lry
  const r = rectFromQuad([10, 20, 50, 20, 10, 35, 50, 35]);
  assert.deepEqual(r, { x: 10, y: 20, w: 40, h: 15 });
});
