import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
} from "../providers/embedding-provider.js";
import { createEmbeddingProvider } from "../providers/embedding-provider.js";

let provider: EmbeddingProvider | null = null;
let providerConfig: EmbeddingProviderConfig | null = null;

export function configureEmbeddings(config: EmbeddingProviderConfig): void {
  providerConfig = config;
  provider = null;
}

function getProvider(): EmbeddingProvider {
  if (!provider) {
    if (!providerConfig) {
      throw new Error(
        "Embedding provider not configured. Call configureEmbeddings() first.",
      );
    }
    provider = createEmbeddingProvider(providerConfig);
  }
  return provider;
}

export async function getEmbedding(text: string): Promise<number[]> {
  return getProvider().embedSingle(text);
}

export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  return getProvider().embed(texts);
}
