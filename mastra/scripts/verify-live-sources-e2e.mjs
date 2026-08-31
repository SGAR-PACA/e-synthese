import assert from 'node:assert/strict';

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:4112';
const apiKey = process.env.E2E_PROXY_API_KEY || 'sk-proxy-e2e-verification';

const response = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'mock-writer',
    stream: true,
    messages: [{ role: 'user', content: 'Quel est le budget de validation ?' }],
  }),
});

const raw = await response.text();
assert.equal(response.status, 200, raw);
let content = '';
for (const line of raw.split('\n')) {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
  const event = JSON.parse(line.slice(6));
  content += event.choices?.[0]?.delta?.content || '';
}

assert.match(content, /42 M€/);
assert.match(content, /\*\*Sources :\*\*/);
assert.match(content, /validation-e2e\.pdf/);

process.stdout.write(JSON.stringify({ ok: true, content }, null, 2) + '\n');
