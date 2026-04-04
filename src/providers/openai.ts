import type { EmbeddingProvider, EmbeddingProviderConfig } from "./embedding-provider.js";

const DEFAULT_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSION = 1536;
const DEFAULT_BATCH_SIZE = 2048;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503]);

interface OpenAIEmbeddingResponse {
  data: Array<{ index: number; embedding: number[] }>;
}

export class OpenAIProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimension: number;

  private readonly url: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly batchSize: number;

  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private static readonly FAILURE_THRESHOLD = 3;
  private static readonly RESET_TIMEOUT_MS = 60_000;

  constructor(config: EmbeddingProviderConfig) {
    this.url = config.baseUrl ?? DEFAULT_URL;
    this.model = config.model ?? DEFAULT_MODEL;
    this.dimension = config.dimensions ?? DEFAULT_DIMENSION;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;

    const key = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OpenAI API key required (config.apiKey or OPENAI_API_KEY env)");
    this.apiKey = key;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: Array<{ index: number; embedding: number[] }> = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const batchResults = await this.callApi(batch);
      for (const item of batchResults) {
        results.push({ index: i + item.index, embedding: item.embedding });
      }
    }

    results.sort((a, b) => a.index - b.index);
    return results.map((r) => r.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }

  private async callApi(
    texts: string[],
    attempt = 0,
  ): Promise<Array<{ index: number; embedding: number[] }>> {
    if (Date.now() < this.circuitOpenUntil) {
      throw new Error(`Circuit breaker open for ${this.name} — will retry after ${new Date(this.circuitOpenUntil).toISOString()}`);
    }

    const body = JSON.stringify({
      input: texts,
      model: this.model,
      dimensions: this.dimension,
    });

    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });

    if (!response.ok) {
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        return this.callApi(texts, attempt + 1);
      }
      const errBody = await response.text().catch(() => "");
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= OpenAIProvider.FAILURE_THRESHOLD) {
        this.circuitOpenUntil = Date.now() + OpenAIProvider.RESET_TIMEOUT_MS;
        console.error(`[${this.name}] Circuit breaker OPEN after ${this.consecutiveFailures} failures. Will reset at ${new Date(this.circuitOpenUntil).toISOString()}`);
      }
      throw new Error(`OpenAI embedding API error ${response.status}: ${errBody.slice(0, 200)}`);
    }

    this.consecutiveFailures = 0;
    const data = (await response.json()) as OpenAIEmbeddingResponse;
    return data.data;
  }
}
