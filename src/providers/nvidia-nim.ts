import type { EmbeddingProvider, EmbeddingProviderConfig } from "./embedding-provider.js";

const DEFAULT_URL = "https://integrate.api.nvidia.com/v1/embeddings";
const DEFAULT_MODEL = "nvidia/nv-embedqa-e5-v5";
const DEFAULT_DIMENSION = 1024;
const DEFAULT_BATCH_SIZE = 96;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

interface NimEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

export class NvidiaNimProvider implements EmbeddingProvider {
  readonly name = "nvidia-nim";
  readonly dimension: number;

  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly batchSize: number;

  constructor(config: Partial<EmbeddingProviderConfig> = {}) {
    this.url = config.baseUrl ?? DEFAULT_URL;
    this.model = config.model ?? DEFAULT_MODEL;
    this.dimension = config.dimensions ?? DEFAULT_DIMENSION;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;

    const key = config.apiKey ?? process.env.NVIDIA_NIM_API_KEY;
    if (!key) {
      throw new Error(
        "NVIDIA NIM API key required. Pass apiKey in config or set NVIDIA_NIM_API_KEY env var.",
      );
    }
    this.apiKey = key;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResults = await this.callApi(batch);
      results.push(...batchResults);
    }
    return results;
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }

  private async callApi(inputs: string[]): Promise<number[][]> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: inputs,
            model: this.model,
            input_type: "passage",
          }),
        });

        if (RETRYABLE_STATUS_CODES.has(response.status)) {
          throw new NimApiError(
            `HTTP ${response.status}: ${response.statusText}`,
            response.status,
            true,
          );
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new NimApiError(
            `HTTP ${response.status}: ${body || response.statusText}`,
            response.status,
            false,
          );
        }

        const data = (await response.json()) as NimEmbeddingResponse;
        return data.data
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable =
          err instanceof NimApiError ? err.retryable : isNetworkError(err);

        if (!retryable || attempt >= MAX_RETRIES) break;

        const delay = BASE_DELAY_MS * 2 ** attempt;
        await sleep(delay);
      }
    }

    throw lastError;
  }
}

export class NimApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NimApiError";
  }
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof Error && "code" in err) {
    const code = (err as { code: string }).code;
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"].some(
      (c) => code.startsWith(c),
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
