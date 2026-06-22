import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fusionnerEtDedupliquer } from '../src/mastra/pipeline/retrieval.js';

const c = (content: string, score = 0.5) => ({ score, content, name: 'doc', url: '' });

test('fusion : concatène plusieurs paquets', () => {
  const out = fusionnerEtDedupliquer([[c('a')], [c('b')]]);
  assert.equal(out.length, 2);
});

test('fusion : déduplique par contenu identique', () => {
  const out = fusionnerEtDedupliquer([[c('meme')], [c('meme'), c('autre')]]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.content).sort(), ['autre', 'meme']);
});

test('fusion : garde le meilleur score en cas de doublon', () => {
  const out = fusionnerEtDedupliquer([[c('x', 0.3)], [c('x', 0.9)]]);
  assert.equal(out.length, 1);
  assert.equal(out[0].score, 0.9);
});
