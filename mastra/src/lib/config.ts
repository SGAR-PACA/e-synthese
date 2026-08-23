import { getConfigValue, setConfigValue, getEncryptionKey } from './db.js';
import { encrypt, decrypt } from './crypto.js';

export interface AppConfig {
  albertApiKey: string;
  albertApiBaseUrl: string;
  albertMaxRpm: number;     // plafond local de requêtes Albert par minute
  llmModel: string;
  defaultCollections: number[];
  maxSearchQueries: number; // nombre maximal de sous-requêtes du planificateur
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
  topP: number;            // nucleus sampling ; 1 = désactivé
  maxOutputTokens: number; // plafond de longueur de la réponse utilisateur
  judgeTemperature: number;
  judgeMaxCompletionTokens: number;
  evalWideSearch: boolean; // recherche supplémentaire du judge (coûte 1 appel)
}

const DEFAULTS: AppConfig = {
  albertApiKey: '',
  albertApiBaseUrl: 'https://albert.api.etalab.gouv.fr',
  albertMaxRpm: 8,
  llmModel: 'openweight-large',
  defaultCollections: [],
  maxSearchQueries: 2,
  searchK: 5,
  minScore: 0.5,
  useRerank: true,
  ragPromptTemplate: `Tu es un assistant IA de l'administration française (projet E-Synthèse, SGAR PACA).\nUtilise le contexte ci-dessous pour répondre. Si le contexte ne contient pas l'information, dis-le clairement.\nCite tes sources quand c'est possible. Réponds toujours en français.\n\nCONTEXTE :\n{context}`,
  adminContactEmail: '',
  // Juge par défaut : DeepSeek V4 Flash. Il est distinct du modèle de génération
  // (gpt-oss-120b / openweight-large) et est exposé par Albert comme text-generation.
  judgeModel: 'deepseek-v4-flash',
  // Éval échantillonnée : 0.1 par défaut. La clé Albert (~10 req/min) est PARTAGÉE par tous
  // les users ; à 1.0 l'éval sature le quota. Réglable dans l'admin sans redéploiement.
  evalSamplingRate: 0.1,
  evalWideK: 20,
  // Désactivé en live pour éviter la recherche supplémentaire ; activable dans l'admin
  // lors d'un audit complet du retrieval.
  evalWideSearch: false,
  searchWideK: 20,
  finalK: 8,
  rerankMinScore: 0.2,
  temperature: 0.2,
  topP: 1,
  maxOutputTokens: 2048,
  judgeTemperature: 0,
  judgeMaxCompletionTokens: 512,
};

// Anciennes valeurs qui ne sont plus exposées comme `text-generation` par le
// catalogue Albert actuel. Une configuration persistée avec l'un de ces alias
// bascule automatiquement vers un judge compatible.
const LEGACY_UNSUPPORTED_JUDGE_MODELS = new Set(['openweight-medium', 'openweight-small']);

function resolveJudgeModel(value: string): string {
  return LEGACY_UNSUPPORTED_JUDGE_MODELS.has(value) ? DEFAULTS.judgeModel : value;
}

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
  const maxRpm = parseInt((await getConfigValue('albertMaxRpm')) || process.env.ALBERT_MAX_RPM || String(DEFAULTS.albertMaxRpm), 10);
  config.albertMaxRpm = Number.isFinite(maxRpm) && maxRpm >= 1 && maxRpm <= 100 ? maxRpm : DEFAULTS.albertMaxRpm;
  config.llmModel = (await getConfigValue('llmModel')) || process.env.LLM_MODEL || DEFAULTS.llmModel;
  const maxSearchQueries = parseInt((await getConfigValue('maxSearchQueries')) || process.env.MAX_SEARCH_QUERIES || String(DEFAULTS.maxSearchQueries), 10);
  config.maxSearchQueries = Number.isFinite(maxSearchQueries) && maxSearchQueries >= 1 && maxSearchQueries <= 4
    ? maxSearchQueries
    : DEFAULTS.maxSearchQueries;
  config.searchK = parseInt((await getConfigValue('searchK')) || process.env.SEARCH_K || String(DEFAULTS.searchK), 10);
  config.minScore = parseFloat((await getConfigValue('minScore')) || process.env.MIN_SCORE || String(DEFAULTS.minScore));
  config.searchWideK = parseInt((await getConfigValue('searchWideK')) || process.env.SEARCH_WIDE_K || String(DEFAULTS.searchWideK), 10);
  config.finalK = parseInt((await getConfigValue('finalK')) || process.env.FINAL_K || String(DEFAULTS.finalK), 10);
  config.rerankMinScore = parseFloat((await getConfigValue('rerankMinScore')) || process.env.RERANK_MIN_SCORE || String(DEFAULTS.rerankMinScore));
  config.temperature = parseFloat((await getConfigValue('temperature')) || process.env.LLM_TEMPERATURE || String(DEFAULTS.temperature));
  const maxOutputTokens = parseInt((await getConfigValue('maxOutputTokens')) || process.env.LLM_MAX_OUTPUT_TOKENS || String(DEFAULTS.maxOutputTokens), 10);
  config.maxOutputTokens = Number.isFinite(maxOutputTokens) && maxOutputTokens >= 256 && maxOutputTokens <= 4096
    ? maxOutputTokens
    : DEFAULTS.maxOutputTokens;
  const topPRaw = (await getConfigValue('topP')) ?? process.env.LLM_TOP_P;
  const topP = topPRaw == null || topPRaw === '' ? DEFAULTS.topP : parseFloat(topPRaw);
  config.topP = Number.isFinite(topP) && topP >= 0 && topP <= 1 ? topP : DEFAULTS.topP;
  config.useRerank = ((await getConfigValue('useRerank')) ?? process.env.USE_RERANK ?? String(DEFAULTS.useRerank)) === 'true';
  config.ragPromptTemplate = (await getConfigValue('ragPromptTemplate')) || DEFAULTS.ragPromptTemplate;
  config.adminContactEmail = (await getConfigValue('adminContactEmail')) || '';
  config.judgeModel = resolveJudgeModel(
    (await getConfigValue('judgeModel')) || process.env.ALBERT_JUDGE_MODEL || DEFAULTS.judgeModel,
  );
  if (config.judgeModel === config.llmModel) {
    // Évite le biais d'auto-évaluation même si une ancienne configuration DB
    // contient le même modèle que celui de génération.
    config.judgeModel = config.llmModel === DEFAULTS.judgeModel ? 'openweight-large' : DEFAULTS.judgeModel;
  }

  const rate = parseFloat((await getConfigValue('evalSamplingRate')) || process.env.EVAL_SAMPLING_RATE || String(DEFAULTS.evalSamplingRate));
  config.evalSamplingRate = Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULTS.evalSamplingRate;

  const judgeTemperature = parseFloat((await getConfigValue('judgeTemperature')) || process.env.JUDGE_TEMPERATURE || String(DEFAULTS.judgeTemperature));
  config.judgeTemperature = Number.isFinite(judgeTemperature) && judgeTemperature >= 0 && judgeTemperature <= 1
    ? judgeTemperature
    : DEFAULTS.judgeTemperature;
  const judgeMaxTokens = parseInt((await getConfigValue('judgeMaxCompletionTokens')) || process.env.JUDGE_MAX_COMPLETION_TOKENS || String(DEFAULTS.judgeMaxCompletionTokens), 10);
  config.judgeMaxCompletionTokens = Number.isFinite(judgeMaxTokens) && judgeMaxTokens >= 128 && judgeMaxTokens <= 2048
    ? judgeMaxTokens
    : DEFAULTS.judgeMaxCompletionTokens;

  config.evalWideSearch = ((await getConfigValue('evalWideSearch')) ?? process.env.EVAL_WIDE_SEARCH ?? String(DEFAULTS.evalWideSearch)) === 'true';

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
