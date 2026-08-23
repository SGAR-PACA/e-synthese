import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coercePlan } from '../src/mastra/pipeline/planner.js';

test('coercePlan : plan direct valide', () => {
  const p = coercePlan({ type: 'direct', reponse_directe: 'Bonjour !' }, 'bonjour');
  assert.equal(p.type, 'direct');
  if (p.type === 'direct') assert.equal(p.reponseDirecte, 'Bonjour !');
});

test('coercePlan : plan recherche borné à 2 requêtes pour limiter les appels Albert', () => {
  const p = coercePlan({ type: 'recherche', requetes: ['a', 'b', 'c', 'd', 'e'] }, 'q');
  assert.equal(p.type, 'recherche');
  if (p.type === 'recherche') assert.equal(p.requetes.length, 2);
});

test('coercePlan : respecte la limite réglée par l’administrateur', () => {
  const p = coercePlan({ type: 'recherche', requetes: ['a', 'b', 'c'] }, 'q', 1);
  assert.equal(p.type, 'recherche');
  if (p.type === 'recherche') assert.deepEqual(p.requetes, ['a']);
});

test('coercePlan : format illisible → repli sur la question brute', () => {
  const p = coercePlan(null, 'ma question');
  assert.equal(p.type, 'recherche');
  if (p.type === 'recherche') assert.deepEqual(p.requetes, ['ma question']);
});

test('coercePlan : recherche sans requêtes → repli sur la question brute', () => {
  const p = coercePlan({ type: 'recherche', requetes: [] }, 'ma question');
  assert.equal(p.type, 'recherche');
  if (p.type === 'recherche') assert.deepEqual(p.requetes, ['ma question']);
});
