import { createServer } from 'node:http';

const port = Number(process.env.MOCK_ALBERT_PORT || 55440);
const requests = [];

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function completion(content, model = 'mock-model') {
  return {
    id: `mock-${requests.length}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch {}
  requests.push({ method: req.method, url: req.url, body });

  if (req.method === 'GET' && req.url === '/requests') return send(res, 200, { requests });
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    return send(res, 200, { data: [
      { id: 'mock-writer', type: 'text-generation', aliases: [] },
      { id: 'mock-judge', type: 'text-generation', aliases: [] },
    ] });
  }
  if (req.method === 'GET' && req.url?.startsWith('/v1/collections')) {
    return send(res, 200, { data: [{ id: 1, name: 'Collection E2E' }] });
  }
  if (req.method === 'POST' && req.url === '/v1/search') {
    return send(res, 200, {
      data: [{
        score: 0.91,
        chunk: {
          id: 'chunk-e2e',
          document_id: 'document-e2e',
          content: 'Le budget de validation est fixé à 42 M€.',
          metadata: { document_name: 'validation-e2e.pdf', collection_id: 1 },
        },
      }],
    });
  }
  if (req.method === 'POST' && req.url === '/v1/rerank') {
    return send(res, 200, { results: [{ index: 0, relevance_score: 0.97 }] });
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const text = (body?.messages || []).map((message) => String(message.content || '')).join('\n');
    if (text.includes('planificateur')) {
      return send(res, 200, completion(
        JSON.stringify({ type: 'recherche', requetes: ['budget validation'] }),
        body.model,
      ));
    }
    if (body?.response_format?.type === 'json_object') {
      return send(res, 200, completion(JSON.stringify({
        system_prompt: { score: 1, reason: 'Prompt configurable respecté.' },
        faithfulness: { score: 1, reason: 'Réponse étayée.' },
        completeness: { score: 1, reason: 'Information complète.' },
        retrieval_quality: { score: 1, reason: 'Passage pertinent.' },
      }), body.model));
    }
    // Rend visible la différence entre une requête HTTP synchrone et le job
    // détaché : la création du test doit répondre avant cette temporisation.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return send(res, 200, completion(
      'Le budget de validation est de **42 M€**.\n\n**Sources :**\n- Source 1 : *validation-e2e.pdf*',
      body?.model,
    ));
  }

  return send(res, 404, { error: `Route mock inconnue: ${req.method} ${req.url}` });
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock-albert-ready:${port}\n`);
});
