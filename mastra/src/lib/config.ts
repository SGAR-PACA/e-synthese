import { getConfigValue, setConfigValue, getEncryptionKey } from './db.js';
import { encrypt, decrypt } from './crypto.js';

export interface AppConfig {
  albertApiKey: string;
  albertApiBaseUrl: string;
  llmModel: string;
  defaultCollections: number[];
  searchK: number;
  minScore: number;
  useRerank: boolean;
  ragPromptTemplate: string;
  adminContactEmail: string;
  judgeModel: string;      // modèle LLM-juge de la notation (distinct du modèle de génération)
  evalSamplingRate: number;
  evalWideK: number;
  searchWideK: number;     // k par recherche (pêche large) — pipeline RAG
  finalK: number;          // passages finaux gardés après rerank
  rerankMinScore: number;  // seuil de note de rerank (anti-hallucination)
  temperature: number;     // température par défaut du rédacteur
}

const DEFAULTS: AppConfig = {
  albertApiKey: '',
  albertApiBaseUrl: 'https://albert.api.etalab.gouv.fr',
  llmModel: 'openweight-large',
  defaultCollections: [],
  searchK: 5,
  minScore: 0.5,
  useRerank: true,
  ragPromptTemplate: `Tu es un assistant IA de l'administration française (projet E-Synthèse, SGAR PACA).\nUtilise le contexte ci-dessous pour répondre. Si le contexte ne contient pas l'information, dis-le clairement.\nCite tes sources quand c'est possible. Réponds toujours en français.\n\nCONTEXTE :\n{context}`,
  adminContactEmail: '',
  // Juge par défaut : Mistral Small 3.2 24B (openweight-medium). DISTINCT du modèle de
  // génération (gpt-oss-120b / openweight-large) pour éviter le biais d'auto-préférence.
  judgeModel: 'openweight-medium',
  // Éval échantillonnée : 0.3 par défaut. La clé Albert (~10 req/min) est PARTAGÉE par tous
  // les users ; à 1.0 l'éval sature le quota. Réglable dans l'admin sans redéploiement.
  evalSamplingRate: 0.3,
  evalWideK: 20,
  searchWideK: 20,
  finalK: 8,
  rerankMinScore: 0.2,
  temperature: 0.2,
};

const ENCRYPTED_KEYS = new Set(['albertApiKey']);

async function readConfigKey(key: string): Promise<string | undefined> {
  const raw = await getConfigValue(key);
  if (!raw) return undefined;
  if (ENCRYPTED_KEYS.has(key)) {
    try {
      const parsed = JSON.parse(raw);
      return decrypt(parsed.encrypted, parsed.iv, parsed.tag, getEncryptionKey());
    } catch {
      return undefined;
    }
  }
  return raw;
}

async function writeConfigKey(key: string, value: string): Promise<void> {
  if (ENCRYPTED_KEYS.has(key)) {
    const encResult = encrypt(value, getEncryptionKey());
    await setConfigValue(key, JSON.stringify(encResult));
  } else {
    await setConfigValue(key, value);
  }
}

export async function getConfig(): Promise<AppConfig> {
  const config = { ...DEFAULTS };
  config.albertApiKey = (await readConfigKey('albertApiKey')) || process.env.ALBERT_API_KEY || DEFAULTS.albertApiKey;
  config.albertApiBaseUrl = (await getConfigValue('albertApiBaseUrl')) || process.env.ALBERT_API_BASE_URL || DEFAULTS.albertApiBaseUrl;
  config.llmModel = (await getConfigValue('llmModel')) || process.env.LLM_MODEL || DEFAULTS.llmModel;
  config.searchK = parseInt((await getConfigValue('searchK')) || process.env.SEARCH_K || String(DEFAULTS.searchK), 10);
  config.minScore = parseFloat((await getConfigValue('minScore')) || process.env.MIN_SCORE || String(DEFAULTS.minScore));
  config.searchWideK = parseInt((await getConfigValue('searchWideK')) || process.env.SEARCH_WIDE_K || String(DEFAULTS.searchWideK), 10);
  config.finalK = parseInt((await getConfigValue('finalK')) || process.env.FINAL_K || String(DEFAULTS.finalK), 10);
  config.rerankMinScore = parseFloat((await getConfigValue('rerankMinScore')) || process.env.RERANK_MIN_SCORE || String(DEFAULTS.rerankMinScore));
  config.temperature = parseFloat((await getConfigValue('temperature')) || process.env.LLM_TEMPERATURE || String(DEFAULTS.temperature));
  config.useRerank = ((await getConfigValue('useRerank')) ?? process.env.USE_RERANK ?? String(DEFAULTS.useRerank)) === 'true';
  config.ragPromptTemplate = (await getConfigValue('ragPromptTemplate')) || DEFAULTS.ragPromptTemplate;
  config.adminContactEmail = (await getConfigValue('adminContactEmail')) || '';
  config.judgeModel = (await getConfigValue('judgeModel')) || process.env.ALBERT_JUDGE_MODEL || DEFAULTS.judgeModel;

  const rate = parseFloat((await getConfigValue('evalSamplingRate')) || process.env.EVAL_SAMPLING_RATE || String(DEFAULTS.evalSamplingRate));
  config.evalSamplingRate = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULTS.evalSamplingRate;

  const wideK = parseInt((await getConfigValue('evalWideK')) || process.env.EVAL_WIDE_K || String(DEFAULTS.evalWideK), 10);
  config.evalWideK = Number.isFinite(wideK) && wideK > 0 ? wideK : DEFAULTS.evalWideK;

  const collectionsRaw = await getConfigValue('defaultCollections');
  if (collectionsRaw) {
    try { config.defaultCollections = JSON.parse(collectionsRaw); } catch {}
  } else if (process.env.DEFAULT_COLLECTIONS) {
    config.defaultCollections = process.env.DEFAULT_COLLECTIONS.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
  }

  return config;
}

export async function updateConfig(updates: Partial<AppConfig>): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (key === 'defaultCollections') {
      await writeConfigKey(key, JSON.stringify(value));
    } else if (typeof value === 'boolean') {
      await writeConfigKey(key, String(value));
    } else if (typeof value === 'number') {
      await writeConfigKey(key, String(value));
    } else {
      await writeConfigKey(key, value as string);
    }
  }
}

export async function initConfigFromEnv(): Promise<void> {
  if (!(await getConfigValue('albertApiKey')) && process.env.ALBERT_API_KEY) {
    await writeConfigKey('albertApiKey', process.env.ALBERT_API_KEY);
  }
  if (!(await getConfigValue('albertApiBaseUrl')) && process.env.ALBERT_API_BASE_URL) {
    await writeConfigKey('albertApiBaseUrl', process.env.ALBERT_API_BASE_URL);
  }
}
