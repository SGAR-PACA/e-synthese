// mastra/test/sources-access.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../src/routes/sources.js';

test('escapeHtml : neutralise les caractères dangereux', () => {
  assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
});
