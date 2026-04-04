import type { EmbeddingProvider } from "./embedding-provider.js";

export class OpenAIProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimension = 0;

  embed(_texts: string[]): Promise<number[][]> {
    throw new Error("OpenAI embedding provider not yet implemented");
  }

  embedSingle(_text: string): Promise<number[]> {
    throw new Error("OpenAI embedding provider not yet implemented");
  }
}
