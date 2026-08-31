import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const page = readFileSync(new URL('../public/admin/ratings.html', import.meta.url), 'utf8');
const renderSparkSource = page.match(
  /function renderSpark\(trend\) \{[\s\S]*?\n\}\n\n\/\* ---- Filtrage/,
)?.[0].replace(/\n\n\/\* ---- Filtrage[\s\S]*$/, '');

assert.ok(renderSparkSource, 'fonction renderSpark introuvable dans ratings.html');

function render(trend: unknown[]): string {
  const spark = { innerHTML: '' };
  const context = vm.createContext({
    document: { getElementById: () => spark },
  });
  vm.runInContext(`${renderSparkSource}; renderSpark(${JSON.stringify(trend)});`, context);
  return spark.innerHTML;
}

test('graphique notes : une seule journée affiche son point et sa date', () => {
  const svg = render([{ date: '2026-08-31', avg: 4.67, count: 6 }]);
  assert.match(svg, /<circle/);
  assert.match(svg, /31\/08 : 4\.67\/5 \(6 note\(s\)\)/);
  assert.doesNotMatch(svg, /Données insuffisantes|NaN|Infinity/);
});

test('graphique notes : aucune journée explique précisément la période vide', () => {
  const svg = render([]);
  assert.match(svg, /Aucune note sur les 30 derniers jours/);
});

test('graphique notes : plusieurs journées conservent courbe, aire et dates', () => {
  const svg = render([
    { date: '2026-08-30', avg: 3, count: 1 },
    { date: '2026-08-31', avg: 5, count: 2 },
  ]);
  assert.match(svg, /fill="url\(#g\)"/);
  assert.match(svg, /30\/08/);
  assert.match(svg, /31\/08/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
});
