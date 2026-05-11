import { NvidiaNimProvider } from "./nvidia-nim.js";
import { OpenAIProvider } from "./openai.js";
import { OnnxProvider } from "./onnx.js";
import { LocalProvider } from "./local.js";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
}

export interface EmbeddingProviderConfig {
  provider: "nvidia-nim" | "openai" | "onnx" | "local";
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  batchSize?: number;
  dimensions?: number;
}

export function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
): EmbeddingProvider {
  switch (config.provider) {
    case "nvidia-nim":
      return new NvidiaNimProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "onnx":
      return new OnnxProvider();
    case "local":
      return new LocalProvider();
    default:
      throw new Error(
        `Unknown embedding provider: ${config.provider}. Available: nvidia-nim, openai, onnx, local`,
      );
  }
}
