import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignedQuery } from '../src/lib/source-token.ts';
import { parseCitedSources } from '../src/lib/cited-sources.ts';

test('parseCitedSources ne garde que les liens à signature valide', () => {
  const key = 'k'.repeat(32);
  const exp = 4_000_000_000_000;
  const q = buildSignedQuery('doc1', ['c1', 'c2'], exp, key);
  const answer = `Texte.\n\n**Sources :**\n- [Mon fichier.pdf](/v1/source/doc1?${q})`;
  const out = parseCitedSources(answer, key, 1_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].documentId, 'doc1');
  assert.deepEqual(out[0].chunkIds, ['c1', 'c2']);
  assert.match(out[0].href, /^\/v1\/source\/doc1\?used=/);

  const forged = `[x](/v1/source/doc9?used=c1&exp=${exp}&sig=AAAA)`;
  assert.equal(parseCitedSources(forged, key, 1_000).length, 0);
});
