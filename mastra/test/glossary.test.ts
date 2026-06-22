import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACRONYMES, renderGlossaire } from '../src/mastra/pipeline/glossary.js';

test('glossaire : contient les acronymes métier clés', () => {
  assert.equal(ACRONYMES['DSIL'], "Dotation de Soutien à l'Investissement Local");
  assert.ok(ACRONYMES['SGAR']);
});

test('renderGlossaire : produit des lignes "ACRO = libellé"', () => {
  const out = renderGlossaire();
  assert.match(out, /DSIL = Dotation de Soutien à l'Investissement Local/);
  assert.match(out, /DETR = /);
});
