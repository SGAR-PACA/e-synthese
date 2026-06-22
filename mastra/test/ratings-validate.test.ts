import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRatingInput } from '../src/lib/ratings-validate.js';

const base = { message_id: 'm1', conversation_id: 'c1', rating: 4, comment: 'bien', question: 'q', answer: 'a' };

test('accepte une note valide', () => {
  const r = validateRatingInput(base);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.rating, 4);
});

test('refuse une note hors borne', () => {
  assert.equal(validateRatingInput({ ...base, rating: 6 }).ok, false);
  assert.equal(validateRatingInput({ ...base, rating: 0 }).ok, false);
});

test('refuse une note non entière', () => {
  assert.equal(validateRatingInput({ ...base, rating: 3.5 }).ok, false);
});

test('refuse si message_id manquant', () => {
  assert.equal(validateRatingInput({ ...base, message_id: '' }).ok, false);
});

test('tronque les champs texte trop longs', () => {
  const r = validateRatingInput({ ...base, comment: 'x'.repeat(5000) });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.comment.length, 2000);
});

test('refuse un body non-objet', () => {
  assert.equal(validateRatingInput(null).ok, false);
  assert.equal(validateRatingInput('x').ok, false);
});
