import { getConfig } from './config.js';

const ALBERT_TIMEOUT_MS = 120_000;

async function albertFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const config = await getConfig();
  const url = `${config.albertApiBaseUrl}${path}`;
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${config.albertApiKey}`);

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(url, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(ALBERT_TIMEOUT_MS),
  });
}

// Récupère TOUTES les pages d'un endpoint de liste Albert (pagination limit/offset,
// `data[]` par page). Sans ça, Albert ne renvoie que les 10 premiers éléments (défaut).
async function collectPaginated(basePath: string): Promise<any[]> {
  const out: any[] = [];
  const limit = 100;
  let offset = 0;
  const sep = basePath.includes('?') ? '&' : '?';
  for (let guard = 0; guard < 1000; guard++) {
    const res = await albertFetch(`${basePath}${sep}limit=${limit}&offset=${offset}`);
    if (!res.ok) break;
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
  const res = await albertFetch('/v1/documents', {
    method: 'POST',
    body: formData,
  });
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

export async function search(data: { query: string; collections: number[]; k?: number }) {
  const res = await albertFetch('/v1/search', {
    method: 'POST',
    body: JSON.stringify(data),
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
  stream?: boolean;
}) {
  const res = await albertFetch('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify(data),
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
