import type { EmbeddingProvider } from "./embedding-provider.js";

export class LocalProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly dimension = 0;

  embed(_texts: string[]): Promise<number[][]> {
    throw new Error("Local embedding provider not yet implemented");
  }

  embedSingle(_text: string): Promise<number[]> {
    throw new Error("Local embedding provider not yet implemented");
  }
}
