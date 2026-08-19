import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMergedJudgePrompt,
  buildJudgeMessages,
  parseMergedJudgeResponse,
  expectedMetrics,
} from '../src/mastra/scorers/index.js';

const input = {
  question: 'Quelle est la procédure ?',
  answer: 'La procédure est X.\n\nSources : doc1',
  contexts: ['chunk A', 'chunk B'],
  wideContexts: ['chunk A', 'chunk B', 'chunk C'],
  instructions: 'Réponds en français, cite les sources.',
};

test('expectedMetrics : 4 métriques en cas normal, 1 (system_prompt) sur refus', () => {
  assert.deepEqual(expectedMetrics(false), ['systemPrompt', 'faithfulness', 'completeness', 'retrievalQuality']);
  assert.deepEqual(expectedMetrics(true), ['systemPrompt']);
});

test('buildMergedJudgePrompt : demande les 4 critères et le vivier élargi (cas normal)', () => {
  const p = buildMergedJudgePrompt(input, false);
  for (const k of ['system_prompt', 'faithfulness', 'completeness', 'retrieval_quality']) {
    assert.ok(p.includes(k), `le prompt doit mentionner ${k}`);
  }
  assert.ok(p.includes('chunk C'), 'le vivier élargi doit être inclus');
});

test('buildMergedJudgePrompt : sur refus, seul system_prompt est demandé (pas de chunks)', () => {
  const p = buildMergedJudgePrompt(input, true);
  assert.ok(p.includes('system_prompt'));
  assert.ok(!p.includes('faithfulness'), 'pas de faithfulness sur un refus');
  assert.ok(!p.includes('retrieval_quality'), 'pas de retrieval_quality sur un refus');
});

test('buildJudgeMessages : un seul message user incluant les instructions du juge', () => {
  const msgs = buildJudgeMessages(input, false);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.ok(msgs[0].content.includes('évaluateur rigoureux'));
});

test('parseMergedJudgeResponse : JSON propre → 4 notes mappées', () => {
  const text = JSON.stringify({
    system_prompt: { score: 1, reason: 'ok' },
    faithfulness: { score: 0.8, reason: 'étayé' },
    completeness: { score: 0.5, reason: 'partiel' },
    retrieval_quality: { score: 0.9, reason: 'bon vivier' },
  });
  const scores = parseMergedJudgeResponse(text, false);
  assert.equal(scores.length, 4);
  assert.equal(scores[0].metric, 'system_prompt');
  assert.equal(scores[1].score, 0.8);
  assert.equal(scores[3].reason, 'bon vivier');
});

test('parseMergedJudgeResponse : JSON entouré de prose et de ```json', () => {
  const text = 'Voici mon évaluation :\n```json\n{"system_prompt": {"score": 0.7, "reason": "presque"}}\n```\nVoilà.';
  const scores = parseMergedJudgeResponse(text, true);
  assert.equal(scores.length, 1);
  assert.equal(scores[0].score, 0.7);
});

test('parseMergedJudgeResponse : métrique manquante → note 0 + raison explicite', () => {
  const text = JSON.stringify({ system_prompt: { score: 1, reason: 'ok' } });
  const scores = parseMergedJudgeResponse(text, false);
  assert.equal(scores.length, 4);
  const faith = scores.find((s) => s.metric === 'faithfulness');
  assert.equal(faith.score, 0);
  assert.match(faith.reason, /absente/);
});

test('parseMergedJudgeResponse : score textuel coercé, hors bornes rejeté', () => {
  const text = JSON.stringify({ system_prompt: { score: '0.6', reason: 'coercé' } });
  const scores = parseMergedJudgeResponse(text, true);
  assert.equal(scores[0].score, 0.6);

  const bad = JSON.stringify({ system_prompt: { score: 5, reason: 'trop' } });
  const scoresBad = parseMergedJudgeResponse(bad, true);
  assert.equal(scoresBad[0].score, 0, 'un score > 1 est invalide → 0');
});

test('parseMergedJudgeResponse : texte illisible → toutes notes à 0 sans crash', () => {
  const scores = parseMergedJudgeResponse('pas de json ici', false);
  assert.equal(scores.length, 4);
  assert.ok(scores.every((s) => s.score === 0));
});
