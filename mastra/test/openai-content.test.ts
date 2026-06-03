import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentToText } from '../src/lib/openai-content.js';

test('contentToText : une string est renvoyée telle quelle', () => {
  assert.equal(contentToText('Quels sont les objectifs DSIL ?'), 'Quels sont les objectifs DSIL ?');
});

test('contentToText : content structuré OpenAI (cas réel du front) → texte brut', () => {
  // Forme exacte envoyée par Albert Conversation, qui cassait la notation live.
  const content = [{ type: 'text', text: "J'aimerais que tu me donnes les objectifs financiers de la DSIL" }];
  assert.equal(contentToText(content), "J'aimerais que tu me donnes les objectifs financiers de la DSIL");
});

test('contentToText : plusieurs parts text sont concaténées', () => {
  const content = [
    { type: 'text', text: 'Bonjour,' },
    { type: 'text', text: 'quels sont les chiffres ?' },
  ];
  assert.equal(contentToText(content), 'Bonjour, quels sont les chiffres ?');
});

test('contentToText : tableau de chaînes simples', () => {
  assert.equal(contentToText(['a', 'b']), 'a b');
});

test('contentToText : parts non-text ignorées, jamais un tableau sérialisé', () => {
  const content = [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'la vraie question' }];
  const out = contentToText(content);
  assert.equal(out, 'la vraie question');
  assert.ok(!out.includes('{'), 'ne doit jamais contenir de JSON sérialisé');
});

test('contentToText : valeurs vides / non supportées → chaîne vide', () => {
  assert.equal(contentToText(null), '');
  assert.equal(contentToText(undefined), '');
  assert.equal(contentToText({ text: 'x' }), '');
  assert.equal(contentToText([]), '');
});
