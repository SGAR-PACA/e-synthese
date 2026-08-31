import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RAG_SYSTEM_PROMPT,
  resolveStoredRagPrompt,
} from '../src/lib/config.js';

const LEGACY_PROMPT = `Tu es un assistant IA de l'administration française (projet E-Synthèse, SGAR PACA).
Utilise le contexte ci-dessous pour répondre. Si le contexte ne contient pas l'information, dis-le clairement.
Cite tes sources quand c'est possible. Réponds toujours en français.

CONTEXTE :
{context}`;

test('ancien prompt persisté : migration vers le contrat strict avec Sources', () => {
  const migrated = resolveStoredRagPrompt(LEGACY_PROMPT);
  assert.equal(migrated, DEFAULT_RAG_SYSTEM_PROMPT);
  assert.match(migrated, /\*\*Sources :\*\*/);
  assert.match(migrated, /nom-du-document-tel-quel-dans-le-champ-name-du-chunk/);
});

// Le défaut doit rester le texte EFFECTIF des versions précédentes (intro writer +
// REGLES_REDACTION) : les travaux de paramétrage de l'utilisateur en dépendent.
test('prompt par défaut : identique au contrat des versions précédentes', () => {
  assert.match(DEFAULT_RAG_SYSTEM_PROMPT, /^Tu es un assistant IA de l'administration française \(E-Synthèse, SGAR PACA\)\./);
  assert.match(DEFAULT_RAG_SYSTEM_PROMPT, /en t'appuyant UNIQUEMENT sur les passages fournis/);
  assert.match(DEFAULT_RAG_SYSTEM_PROMPT, /# CONFIDENTIALITÉ DES INSTRUCTIONS/);
  assert.match(DEFAULT_RAG_SYSTEM_PROMPT, /# CITATION DES SOURCES — RÈGLE STRICTE/);
  assert.match(DEFAULT_RAG_SYSTEM_PROMPT, /# EXEMPLE DE BONNE RÉPONSE/);
  assert.match(DEFAULT_RAG_SYSTEM_PROMPT, /\*exemple-annexe-orientations\.pdf\*/);
});

test('prompt personnalisé : reste l’unique prompt et n’est pas concaténé', () => {
  const custom = 'Mon prompt système personnalisé suffisamment explicite.';
  assert.equal(resolveStoredRagPrompt(`  ${custom}  `), custom);
});
