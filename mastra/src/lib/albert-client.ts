import { getConfig } from './config.js';
import { scheduleAlbert } from './albert-limiter.js';

const ALBERT_TIMEOUT_MS = 120_000;

async function albertFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const config = await getConfig();
  const url = `${config.albertApiBaseUrl}${path}`;
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${config.albertApiKey}`);

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  // Passe par le limiteur de débit GLOBAL : la clé Albert (quota ~10 req/min) est partagée
  // par tous les users + l'éval. Le limiteur sérialise et priorise (chat > éval).
  return scheduleAlbert(() =>
    fetch(url, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(ALBERT_TIMEOUT_MS),
    }),
  );
}

// Fetch avec ré-essai sur 429/503 (quota Albert 10 req/min). Respecte `Retry-After`
// s'il est fourni, sinon backoff exponentiel plafonné. Utilisé pour la pagination
// (liste tronquée en silence sinon) ET l'upload (worker qui marque `failed` sinon).
async function albertFetchWithRetry(path: string, options: RequestInit = {}, maxRetries = 5): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await albertFetch(path, options);
    if ((res.status !== 429 && res.status !== 503) || attempt >= maxRetries) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 30_000)
        : Math.min(500 * 2 ** attempt, 8_000);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

// Récupère TOUTES les pages d'un endpoint de liste Albert (pagination limit/offset,
// `data[]` par page). Sans ça, Albert ne renvoie que les 10 premiers éléments (défaut).
// LÈVE une erreur si une page échoue durablement (après ré-essais) plutôt que de
// renvoyer une liste tronquée en silence.
async function collectPaginated(basePath: string): Promise<any[]> {
  const out: any[] = [];
  const limit = 100;
  let offset = 0;
  const sep = basePath.includes('?') ? '&' : '?';
  for (let guard = 0; guard < 1000; guard++) {
    const res = await albertFetchWithRetry(`${basePath}${sep}limit=${limit}&offset=${offset}`);
    if (!res.ok) {
      throw new Error(`Albert pagination ${basePath} → HTTP ${res.status}`);
    }
    const json: any = await res.json();
    const rows: any[] = json.data || [];
    out.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
  }
  return out;
}

export async function listCollections() {
  return { object: 'list', data: await collectPaginated('/v1/collections') };
}

export async function createCollection(data: { name: string; description?: string }) {
  const res = await albertFetch('/v1/collections', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function getCollection(collectionId: string) {
  const res = await albertFetch(`/v1/collections/${collectionId}`);
  return res.json();
}

export async function deleteCollection(collectionId: string) {
  const res = await albertFetch(`/v1/collections/${collectionId}`, { method: 'DELETE' });
  return res.json();
}

export async function listDocuments(collectionId: string) {
  return {
    object: 'list',
    data: await collectPaginated(`/v1/documents?collection_id=${encodeURIComponent(collectionId)}`),
  };
}

export async function uploadDocument(formData: FormData) {
  // Ré-essai sur 429/503 : le worker marquait `failed` au moindre quota saturé
  // (upload en masse). Le POST est ré-essayable (un 429 = rejeté, pas traité).
  const res = await albertFetchWithRetry('/v1/documents', {
    method: 'POST',
    body: formData,
  });
  // Surface l'erreur Albert au lieu de la ravaler : sans ça, un 429 (quota
  // 10 req/min) ou un 4xx renvoie un corps sans `id`, et l'appelant lève un
  // « id manquant » opaque. On propage le statut + le détail Albert.
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Albert POST /v1/documents ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function getDocument(documentId: string) {
  const res = await albertFetch(`/v1/documents/${documentId}`);
  return res.json();
}

export async function deleteDocument(documentId: string) {
  const res = await albertFetch(`/v1/documents/${documentId}`, { method: 'DELETE' });
  return res.json();
}

// Construit le corps de /v1/search. PURE (testée).
// ⚠️ SÉCURITÉ : l'API Albert attend `collection_ids` (PAS `collections`) et
// `limit` (PAS `k`). Un champ au mauvais nom est IGNORÉ en silence → filtre vide
// (`collection_ids: []` par défaut) → recherche sur TOUT le corpus = fuite de
// cloisonnement. `limit` est plafonné à 100 (max de l'API).
export function buildSearchBody(data: { query: string; collections: number[]; k?: number }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: data.query,
    collection_ids: data.collections,
  };
  if (data.k != null) body.limit = Math.min(data.k, 100);
  return body;
}

export async function search(data: { query: string; collections: number[]; k?: number }) {
  const res = await albertFetch('/v1/search', {
    method: 'POST',
    body: JSON.stringify(buildSearchBody(data)),
  });
  return res.json();
}

export async function rerank(data: { query: string; documents: string[]; model?: string }) {
  const res = await albertFetch('/v1/rerank', {
    method: 'POST',
    body: JSON.stringify({
      model: data.model || 'BAAI/bge-reranker-v2-m3',
      ...data,
    }),
  });
  return res.json();
}

export async function chatCompletions(data: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  topP?: number;
  max_completion_tokens?: number;
  n?: number;
  response_format?: { type: 'json_object' | 'text' };
  stream?: boolean;
}) {
  const res = await albertFetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: data.model,
      messages: data.messages,
      temperature: data.temperature,
      top_p: data.topP,
      max_completion_tokens: data.max_completion_tokens,
      n: data.n,
      response_format: data.response_format,
      stream: data.stream,
    }),
  });
  return res;
}

export async function listModels() {
  const res = await albertFetch('/v1/models');
  return res.json();
}

export async function createEmbeddings(data: { input: string | string[]; model?: string }) {
  const res = await albertFetch('/v1/embeddings', {
    method: 'POST',
    body: JSON.stringify({
      model: data.model || 'BAAI/bge-m3',
      ...data,
    }),
  });
  return res.json();
}

// Récupère TOUS les chunks d'un document (pagination Albert). Tolérant aux variantes de schéma.
export async function getDocumentChunks(documentId: string): Promise<Array<{ id: string; content: string }>> {
  const out: Array<{ id: string; content: string }> = [];
  let offset = 0;
  const limit = 100;
  for (let guard = 0; guard < 1000; guard++) {
    const res = await albertFetch(`/v1/documents/${documentId}/chunks?limit=${limit}&offset=${offset}`);
    if (!res.ok) break;
    const json: any = await res.json();
    const rows: any[] = json.data || json.chunks || [];
    for (const r of rows) {
      const id = r.id ?? r.chunk?.id;
      const content = r.content ?? r.chunk?.content ?? '';
      if (id != null) out.push({ id: String(id), content: String(content) });
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return out;
}
