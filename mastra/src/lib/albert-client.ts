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

export async function listCollections() {
  const res = await albertFetch('/v1/collections');
  return res.json();
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
  const res = await albertFetch(`/v1/documents?collection_id=${collectionId}`);
  return res.json();
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
