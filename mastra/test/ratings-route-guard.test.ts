// mastra/test/ratings-route-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickRatingError } from '../src/routes/ratings.js';

test('pickRatingError : null si valide', () => {
  assert.equal(pickRatingError({ ok: true }), null);
});

test('pickRatingError : message si invalide', () => {
  assert.equal(pickRatingError({ ok: false }), 'Données de note invalides');
});
