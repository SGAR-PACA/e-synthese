// mastra/test/writer-prompt.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirePromptRedaction } from '../src/mastra/pipeline/writer.js';
import type { RagChunk } from '../src/lib/db.js';

test('le rédacteur reçoit le nom de source normalisé (NFD, tiret spécial, espace invisible)', () => {
  const name = 'Note pré‑CAR cré​dits.pdf'.normalize('NFD');
  const chunks: RagChunk[] = [{ name, content: 'contenu', score: 1, url: '' }];
  const prompt = construirePromptRedaction('Question ?', chunks);
  assert.ok(prompt.includes('(source : Note pré-CAR crédits.pdf)'), prompt);
});

test('le rédacteur ne modifie pas le chunk lui-même (le nom réel sert au remap en base)', () => {
  const name = 'Note pré‑CAR.pdf';
  const chunks: RagChunk[] = [{ name, content: 'contenu', score: 1, url: '' }];
  construirePromptRedaction('Question ?', chunks);
  assert.equal(chunks[0].name, name);
});
