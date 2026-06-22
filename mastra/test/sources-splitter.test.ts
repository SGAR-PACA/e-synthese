import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourcesStreamSplitter } from '../src/lib/sources-linker.js';

// Émet le corps, bufferise le bloc Sources, le réécrit en finalize.
test('streaming : corps émis, bloc Sources réécrit à la fin', () => {
  const s = createSourcesStreamSplitter();
  let emitted = '';
  emitted += s.push('Bonjour le corps. ');
  emitted += s.push('Encore du corps.\n\n**Sources :**\n- Source 1 : *A.pdf*');
  emitted += s.finalize((block) => block.replace('*A.pdf*', '[A.pdf](/v1/source/doc-7?used=c1)'));
  assert.equal(s.sawSources, true);
  assert.match(emitted, /Bonjour le corps\. Encore du corps\./);
  assert.match(emitted, /\[A\.pdf\]\(\/v1\/source\/doc-7\?used=c1\)/);
  assert.doesNotMatch(emitted, /\*A\.pdf\*/);
});

test('streaming : marqueur à cheval sur deux deltas', () => {
  const s = createSourcesStreamSplitter();
  let emitted = '';
  emitted += s.push('Corps.\n\n**Sou');
  emitted += s.push('rces :**\n- Source 1 : *A.pdf*');
  emitted += s.finalize((block) => '[[' + block + ']]');
  assert.equal(s.sawSources, true);
  assert.match(emitted, /Corps\./);
  assert.match(emitted, /\[\[.*Source 1.*\]\]/s);
  // le marqueur ne doit pas avoir fuité dans le corps émis avant le bloc
  assert.doesNotMatch(emitted.split('[[')[0], /\*\*Sources/);
});

test('streaming : sans bloc Sources, tout le corps est émis', () => {
  const s = createSourcesStreamSplitter();
  let emitted = '';
  emitted += s.push('Juste une réponse directe.');
  emitted += s.finalize((block) => '[REWRITE]' + block);
  assert.equal(s.sawSources, false);
  assert.equal(emitted, 'Juste une réponse directe.');
});

test('faux positif : "**Sources officielles**" en milieu de corps ne déclenche pas le splitter', () => {
  const s = createSourcesStreamSplitter();
  let emitted = '';
  // Corps contenant « **Sources officielles** » précédé d'un seul \n (pas \n\n)
  const body = 'Intro.\n**Sources officielles** sont nombreuses.\nSuite du corps.';
  emitted += s.push(body);
  emitted += s.finalize((block) => '[REWRITE]' + block);
  // Le splitter ne doit PAS avoir déclenché
  assert.equal(s.sawSources, false);
  // Tout le corps doit être émis intact (pas de réécriture)
  assert.equal(emitted, body);
});

test('faux positif : seul le vrai bloc final "\\n\\n**Sources :**" déclenche le splitter', () => {
  const s = createSourcesStreamSplitter();
  let emitted = '';
  // Corps avec faux positif en milieu, puis vrai marqueur en fin
  const input = 'Intro.\n**Sources officielles** en milieu.\n\n**Sources :**\n- Source 1 : *A.pdf*';
  emitted += s.push(input);
  emitted += s.finalize((block) => '[[' + block + ']]');
  assert.equal(s.sawSources, true);
  // Le corps avant \n\n**Sources doit être émis sans réécriture
  assert.match(emitted, /Intro\.\n\*\*Sources officielles\*\* en milieu\./);
  // Le vrai bloc Sources doit avoir été réécrit
  assert.match(emitted, /\[\[.*Source 1.*\]\]/s);
});
