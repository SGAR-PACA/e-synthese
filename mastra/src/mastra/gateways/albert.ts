import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { MastraModelGateway, type ProviderConfig, type GatewayLanguageModel } from '@mastra/core/llm';
import { getConfig } from '../../lib/config.js';
import { scheduleAlbert } from '../../lib/albert-limiter.js';

const DEFAULT_BASE_URL = 'https://albert.api.etalab.gouv.fr';

// `fetch` custom : tout appel LLM du chat (planner/writer/agent) passe par le limiteur
// de débit GLOBAL, comme les appels de albert-client. Une seule file pour la clé partagée.
const limitedFetch: typeof fetch = (input, init) => scheduleAlbert(() => fetch(input as any, init));

export class AlbertGateway extends MastraModelGateway {
  readonly id = 'albert';
  readonly name = 'Albert API (etalab)';

  private async getBaseUrl(): Promise<string> {
    const raw = (await getConfig()).albertApiBaseUrl || DEFAULT_BASE_URL;
    return raw.endsWith('/v1') ? raw : `${raw.replace(/\/$/, '')}/v1`;
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      albert: {
        name: 'Albert API',
        models: [
          'openweight-large',
          'openweight-code',
          'deepseek-v4-flash',
        ],
        apiKeyEnvVar: 'ALBERT_API_KEY',
        gateway: this.id,
        url: await this.getBaseUrl(),
        docUrl: 'https://albert.api.etalab.gouv.fr/documentation',
      },
    };
  }

  async buildUrl(): Promise<string> {
    return this.getBaseUrl();
  }

  async getApiKey(): Promise<string> {
    const key = (await getConfig()).albertApiKey || process.env.ALBERT_API_KEY;
    if (!key) {
      throw new Error('Albert API key is not configured (set ALBERT_API_KEY or via admin panel).');
    }
    return key;
  }

  async resolveLanguageModel({
    modelId,
    providerId,
    apiKey,
    headers,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }): Promise<GatewayLanguageModel> {
    const model = createOpenAICompatible({
      name: providerId,
      apiKey,
      baseURL: await this.getBaseUrl(),
      headers,
      fetch: limitedFetch,
    }).chatModel(modelId);
    return model as unknown as GatewayLanguageModel;
  }

  async resolveEmbeddingModel({
    modelId,
    providerId,
    apiKey,
    headers,
  }: {
    modelId: string;
    providerId: string;
    apiKey: string;
    headers?: Record<string, string>;
  }) {
    return createOpenAICompatible({
      name: providerId,
      apiKey,
      baseURL: await this.getBaseUrl(),
      headers,
      fetch: limitedFetch,
    }).textEmbeddingModel(modelId);
  }
}
