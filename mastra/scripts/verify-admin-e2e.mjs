import assert from 'node:assert/strict';

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:4112';
const mockUrl = process.env.MOCK_ALBERT_URL || 'http://127.0.0.1:55440';
const albertConfigUrl = process.env.E2E_ALBERT_CONFIG_URL || mockUrl;
const uniquePrompt = `PROMPT_UNIQUE_E2E
Tu réponds en français uniquement à partir des passages fournis.
Termine par un bloc Sources.`;

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const payload = await response.json();
  return { response, payload };
}

const setup = await json('/admin/setup', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin-e2e@example.test', password: 'Testpass1' }),
});
assert.equal(setup.response.status, 200, JSON.stringify(setup.payload));
assert.equal(setup.payload.ok, true);
assert.ok(setup.payload.csrfToken);
const cookie = setup.response.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(cookie, 'cookie de session admin absent');

const authHeaders = {
  cookie,
  'content-type': 'application/json',
  'x-csrf-token': setup.payload.csrfToken,
};
const saved = await json('/admin/config', {
  method: 'PUT',
  headers: authHeaders,
  body: JSON.stringify({
    ragPromptTemplate: uniquePrompt,
    albertApiBaseUrl: albertConfigUrl,
    albertApiKey: 'mock-api-key',
    llmModel: 'mock-writer',
    judgeModel: 'mock-judge',
    useRerank: true,
  }),
});
assert.equal(saved.response.status, 200, JSON.stringify(saved.payload));
assert.equal(saved.payload.ok, true);

const beforeLaunch = performance.now();
const launched = await json('/admin/test-pipeline', {
  method: 'POST',
  headers: authHeaders,
  body: JSON.stringify({ query: 'Quel est le budget de validation ?', withJudge: true }),
});
const launchDuration = performance.now() - beforeLaunch;
assert.equal(launched.response.status, 202, JSON.stringify(launched.payload));
assert.equal(launched.payload.status, 'queued');
assert.ok(launchDuration < 1500, `le POST est resté bloqué ${Math.round(launchDuration)} ms`);

const testId = launched.payload.id;
const firstRead = await json(`/admin/test-pipeline/${testId}`, { headers: { cookie } });
assert.equal(firstRead.response.status, 200);
assert.ok(['queued', 'running', 'completed'].includes(firstRead.payload.status));

// Simule le départ de la page : aucune requête de polling n'est envoyée pendant
// l'exécution, puis l'historique est relu depuis une nouvelle requête HTTP.
await new Promise((resolve) => setTimeout(resolve, 3000));
let restored;
for (let attempt = 0; attempt < 30; attempt++) {
  restored = await json(`/admin/test-pipeline/${testId}`, { headers: { cookie } });
  if (restored.payload.status === 'completed' || restored.payload.status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert.equal(restored.payload.status, 'completed', restored.payload.error || JSON.stringify(restored.payload));
assert.match(restored.payload.result.answer, /42 M€/);
assert.match(restored.payload.result.answer, /\*\*Sources :\*\*/);
assert.match(restored.payload.result.answer, /validation-e2e\.pdf/);
assert.equal(restored.payload.result.scores.length, 4);

const history = await json('/admin/test-pipeline?limit=30', { headers: { cookie } });
assert.equal(history.response.status, 200);
assert.equal(history.payload.items[0].id, testId);
assert.equal(history.payload.items[0].status, 'completed');

const config = await json('/admin/config', { headers: { cookie } });
assert.equal(config.payload.ragPromptTemplate, uniquePrompt);

const captured = await fetch(`${mockUrl}/requests`).then((response) => response.json());
const chatRequests = captured.requests.filter((request) => request.url === '/v1/chat/completions');
const writerRequest = chatRequests.find((request) =>
  request.body?.messages?.some((message) => message.role === 'system' && message.content === uniquePrompt),
);
assert.ok(writerRequest, 'le rédacteur n’a pas reçu exactement le prompt enregistré dans l’admin');
assert.ok(!writerRequest.body.messages.some((message) =>
  String(message.content).includes('# PROCESSUS POUR CHAQUE QUESTION'),
), 'un ancien prompt codé en dur a été ajouté au prompt admin');
const judgeRequest = chatRequests.find((request) =>
  request.body?.messages?.some((message) => String(message.content).includes('évaluateur rigoureux')),
);
assert.ok(judgeRequest, 'appel du juge absent');
assert.ok(judgeRequest.body.messages.some((message) =>
  String(message.content).includes('évaluateur rigoureux'),
), 'instructions propres au juge absentes');

const testPage = await fetch(`${baseUrl}/admin/test`).then((response) => response.text());
assert.match(testPage, /Historique persistant/);
const ratingsPage = await fetch(`${baseUrl}/admin/ratings-page`).then((response) => response.text());
assert.match(ratingsPage, /Moyenne quotidienne — 30 derniers jours/);

process.stdout.write(JSON.stringify({
  ok: true,
  testId,
  launchDurationMs: Math.round(launchDuration),
  finalStatus: restored.payload.status,
  scoreCount: restored.payload.result.scores.length,
  historyCount: history.payload.items.length,
}, null, 2) + '\n');
