import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRefusal } from '../src/mastra/scorers/refusal.js';

test('isRefusal : détecte un refus explicite', () => {
  assert.equal(isRefusal("Je ne dispose pas d'information sur ce sujet dans les documents."), true);
  assert.equal(isRefusal('Aucun document pertinent ne permet de répondre.'), true);
  assert.equal(isRefusal("Je ne trouve pas d'élément dans le contexte fourni."), true);
});

test("isRefusal : une vraie réponse sourcée n'est pas un refus", () => {
  assert.equal(
    isRefusal('La DSIL 2025 prévoit **400 M€**.\n\n**Sources :**\n- Source 1 : *note.pdf*'),
    false,
  );
});

test('isRefusal : tolère la casse et les accents manquants', () => {
  assert.equal(isRefusal('JE NE DISPOSE PAS de cette information.'), true);
});

test("isRefusal : gère l'apostrophe typographique (sorties Albert/Mistral)", () => {
  assert.equal(isRefusal('Je ne dispose pas d’information dans le contexte fourni.'), true);
  assert.equal(isRefusal('L’information n’est pas disponible dans les documents.'), true);
});
