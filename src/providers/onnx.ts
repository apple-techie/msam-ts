import type { EmbeddingProvider } from "./embedding-provider.js";

export class OnnxProvider implements EmbeddingProvider {
  readonly name = "onnx";
  readonly dimension = 0;

  embed(_texts: string[]): Promise<number[][]> {
    throw new Error("ONNX embedding provider not yet implemented");
  }

  embedSingle(_text: string): Promise<number[]> {
    throw new Error("ONNX embedding provider not yet implemented");
  }
}
