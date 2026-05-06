import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { MastraModelGateway, type ProviderConfig, type GatewayLanguageModel } from '@mastra/core/llm';
import { getConfig } from '../../lib/config.js';

const DEFAULT_BASE_URL = 'https://albert.api.etalab.gouv.fr';

export class AlbertGateway extends MastraModelGateway {
  readonly id = 'albert';
  readonly name = 'Albert API (etalab)';

  private getBaseUrl(): string {
    const raw = getConfig().albertApiBaseUrl || DEFAULT_BASE_URL;
    return raw.endsWith('/v1') ? raw : `${raw.replace(/\/$/, '')}/v1`;
  }

  async fetchProviders(): Promise<Record<string, ProviderConfig>> {
    return {
      albert: {
        name: 'Albert API',
        models: [
          'albert-large',
          'albert-small',
          'albert-code',
          'BAAI/bge-m3',
        ],
        apiKeyEnvVar: 'ALBERT_API_KEY',
        gateway: this.id,
        url: this.getBaseUrl(),
        docUrl: 'https://albert.api.etalab.gouv.fr/documentation',
      },
    };
  }

  buildUrl(): string {
    return this.getBaseUrl();
  }

  async getApiKey(): Promise<string> {
    const key = getConfig().albertApiKey || process.env.ALBERT_API_KEY;
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
      baseURL: this.getBaseUrl(),
      headers,
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
      baseURL: this.getBaseUrl(),
      headers,
    }).textEmbeddingModel(modelId);
  }
}
