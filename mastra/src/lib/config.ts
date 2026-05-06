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
}

const DEFAULTS: AppConfig = {
  albertApiKey: '',
  albertApiBaseUrl: 'https://albert.api.etalab.gouv.fr',
  llmModel: 'albert-large',
  defaultCollections: [],
  searchK: 5,
  minScore: 0.5,
  useRerank: true,
  ragPromptTemplate: `Tu es un assistant IA de l'administration française (projet E-Synthèse, SGAR PACA).\nUtilise le contexte ci-dessous pour répondre. Si le contexte ne contient pas l'information, dis-le clairement.\nCite tes sources quand c'est possible. Réponds toujours en français.\n\nCONTEXTE :\n{context}`,
  adminContactEmail: '',
};

const ENCRYPTED_KEYS = new Set(['albertApiKey']);

function readConfigKey(key: string): string | undefined {
  const raw = getConfigValue(key);
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

function writeConfigKey(key: string, value: string): void {
  if (ENCRYPTED_KEYS.has(key)) {
    const encResult = encrypt(value, getEncryptionKey());
    setConfigValue(key, JSON.stringify(encResult));
  } else {
    setConfigValue(key, value);
  }
}

export function getConfig(): AppConfig {
  const config = { ...DEFAULTS };
  config.albertApiKey = readConfigKey('albertApiKey') || process.env.ALBERT_API_KEY || DEFAULTS.albertApiKey;
  config.albertApiBaseUrl = getConfigValue('albertApiBaseUrl') || process.env.ALBERT_API_BASE_URL || DEFAULTS.albertApiBaseUrl;
  config.llmModel = getConfigValue('llmModel') || process.env.LLM_MODEL || DEFAULTS.llmModel;
  config.searchK = parseInt(getConfigValue('searchK') || process.env.SEARCH_K || String(DEFAULTS.searchK), 10);
  config.minScore = parseFloat(getConfigValue('minScore') || process.env.MIN_SCORE || String(DEFAULTS.minScore));
  config.useRerank = (getConfigValue('useRerank') ?? process.env.USE_RERANK ?? String(DEFAULTS.useRerank)) === 'true';
  config.ragPromptTemplate = getConfigValue('ragPromptTemplate') || DEFAULTS.ragPromptTemplate;
  config.adminContactEmail = getConfigValue('adminContactEmail') || '';

  const collectionsRaw = getConfigValue('defaultCollections');
  if (collectionsRaw) {
    try { config.defaultCollections = JSON.parse(collectionsRaw); } catch {}
  } else if (process.env.DEFAULT_COLLECTIONS) {
    config.defaultCollections = process.env.DEFAULT_COLLECTIONS.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
  }

  return config;
}

export function updateConfig(updates: Partial<AppConfig>): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (key === 'defaultCollections') {
      writeConfigKey(key, JSON.stringify(value));
    } else if (typeof value === 'boolean') {
      writeConfigKey(key, String(value));
    } else if (typeof value === 'number') {
      writeConfigKey(key, String(value));
    } else {
      writeConfigKey(key, value as string);
    }
  }
}

export function initConfigFromEnv(): void {
  if (!getConfigValue('albertApiKey') && process.env.ALBERT_API_KEY) {
    writeConfigKey('albertApiKey', process.env.ALBERT_API_KEY);
  }
  if (!getConfigValue('albertApiBaseUrl') && process.env.ALBERT_API_BASE_URL) {
    writeConfigKey('albertApiBaseUrl', process.env.ALBERT_API_BASE_URL);
  }
}
