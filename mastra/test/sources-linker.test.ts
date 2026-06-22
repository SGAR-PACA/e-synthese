// mastra/test/sources-linker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectSourceLinks } from '../src/lib/sources-linker.js';
import type { RagChunk } from '../src/lib/db.js';

const sign = (documentId: string, chunkIds: string[]) => `used=${chunkIds.join(',')}&sig=X`;
const chunk = (over: Partial<RagChunk>): RagChunk => ({ name: 'A.pdf', content: '', score: 1, url: '', ...over });

test('réécrit une source italique en lien visionneuse', () => {
  const answer = 'Texte.\n\n**Sources :**\n- Source 1 : *A.pdf*';
  const out = injectSourceLinks(answer, [chunk({ name: 'A.pdf', documentId: 'doc-7', chunkId: 'c1' })], sign);
  assert.match(out, /- Source 1 : \[A\.pdf\]\(\/v1\/source\/doc-7\?used=c1&sig=X\)/);
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
