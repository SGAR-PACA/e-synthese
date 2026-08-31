import assert from 'node:assert/strict';

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:4112';

const loginResponse = await fetch(`${baseUrl}/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin-e2e@example.test', password: 'Testpass1' }),
});
const login = await loginResponse.json();
assert.equal(loginResponse.status, 200, JSON.stringify(login));
const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(cookie, 'cookie absent après redémarrage');

const historyResponse = await fetch(`${baseUrl}/admin/test-pipeline?limit=30`, { headers: { cookie } });
const history = await historyResponse.json();
assert.equal(historyResponse.status, 200, JSON.stringify(history));
assert.ok(history.items.length >= 1, 'historique vide après redémarrage');
assert.equal(history.items[0].status, 'completed');

const detailResponse = await fetch(`${baseUrl}/admin/test-pipeline/${history.items[0].id}`, { headers: { cookie } });
const detail = await detailResponse.json();
assert.equal(detailResponse.status, 200, JSON.stringify(detail));
assert.match(detail.result.answer, /42 M€/);
assert.equal(detail.result.scores.length, 4);

const configResponse = await fetch(`${baseUrl}/admin/config`, { headers: { cookie } });
const config = await configResponse.json();
assert.equal(configResponse.status, 200, JSON.stringify(config));
assert.match(config.ragPromptTemplate, /^PROMPT_UNIQUE_E2E/);

process.stdout.write(JSON.stringify({
  ok: true,
  restoredTestId: detail.id,
  restoredStatus: detail.status,
  restoredScores: detail.result.scores.length,
}, null, 2) + '\n');
