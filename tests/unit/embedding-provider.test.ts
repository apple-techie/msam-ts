import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NvidiaNimProvider, NimApiError } from "../../src/providers/nvidia-nim.js";
import { createEmbeddingProvider } from "../../src/providers/embedding-provider.js";

function mockEmbeddingResponse(inputs: number, dimension = 1024) {
  return {
    data: Array.from({ length: inputs }, (_, i) => ({
      index: i,
      embedding: Array.from({ length: dimension }, (_, j) => (i + j) * 0.001),
    })),
  };
}

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number) {
  return new Response("error", { status, statusText: `Status ${status}` });
}

describe("createEmbeddingProvider", () => {
  it("creates NvidiaNimProvider for nvidia-nim", () => {
    const provider = createEmbeddingProvider({
      provider: "nvidia-nim",
      apiKey: "test-key",
    });
    expect(provider.name).toBe("nvidia-nim");
    expect(provider.dimension).toBe(1024);
  });

  it("throws for unknown provider", () => {
    expect(() =>
      createEmbeddingProvider({ provider: "bogus" as never }),
    ).toThrow("Unknown embedding provider: bogus");
  });

  it("creates OpenAI provider with API key", () => {
    const provider = createEmbeddingProvider({ provider: "openai", apiKey: "test-key" });
    expect(provider.name).toBe("openai");
    expect(provider.dimension).toBe(1536);
  });

  it("creates stub providers that throw on use", () => {
    for (const p of ["onnx", "local"] as const) {
      const provider = createEmbeddingProvider({ provider: p });
      expect(() => provider.embed(["test"])).toThrow("not yet implemented");
    }
  });
});

describe("NvidiaNimProvider", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("throws if no API key is provided", () => {
    const saved = process.env.NVIDIA_NIM_API_KEY;
    delete process.env.NVIDIA_NIM_API_KEY;
    try {
      expect(() => new NvidiaNimProvider({})).toThrow("API key required");
    } finally {
      if (saved) process.env.NVIDIA_NIM_API_KEY = saved;
    }
  });

  it("constructs correct API request body", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse(mockEmbeddingResponse(2)));

    const provider = new NvidiaNimProvider({ apiKey: "test-key" });
    await provider.embed(["hello", "world"]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/embeddings");
    expect(opts.method).toBe("POST");

    const headers = opts.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      input: ["hello", "world"],
      model: "nvidia/nv-embedqa-e5-v5",
      input_type: "passage",
    });
  });

  it("returns embeddings sorted by index", async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse({
        data: [
          { index: 1, embedding: [0.2, 0.3] },
          { index: 0, embedding: [0.0, 0.1] },
        ],
      }),
    );

    const provider = new NvidiaNimProvider({
      apiKey: "test-key",
      dimensions: 2,
    });
    const result = await provider.embed(["a", "b"]);

    expect(result).toEqual([
      [0.0, 0.1],
      [0.2, 0.3],
    ]);
  });

  it("splits inputs into batches when exceeding batchSize", async () => {
    const batchSize = 3;
    const inputs = ["a", "b", "c", "d", "e"];

    fetchSpy
      .mockResolvedValueOnce(okResponse(mockEmbeddingResponse(3, 2)))
      .mockResolvedValueOnce(okResponse(mockEmbeddingResponse(2, 2)));

    const provider = new NvidiaNimProvider({
      apiKey: "test-key",
      batchSize,
      dimensions: 2,
    });
    const result = await provider.embed(inputs);

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(firstBody.input).toEqual(["a", "b", "c"]);

    const secondBody = JSON.parse(
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    expect(secondBody.input).toEqual(["d", "e"]);

    expect(result).toHaveLength(5);
  });

  it("retries on transient HTTP errors then succeeds", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(okResponse(mockEmbeddingResponse(1, 2)));

    const provider = new NvidiaNimProvider({
      apiKey: "test-key",
      dimensions: 2,
    });
    const promise = provider.embed(["test"]);

    await vi.advanceTimersByTimeAsync(1000); // first retry delay
    await vi.advanceTimersByTimeAsync(2000); // second retry delay

    const result = await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(1);
    vi.useRealTimers();
  });

  it("does not retry on non-retryable HTTP errors", async () => {
    fetchSpy.mockResolvedValueOnce(errorResponse(401));

    const provider = new NvidiaNimProvider({
      apiKey: "test-key",
    });

    await expect(provider.embed(["test"])).rejects.toThrow("HTTP 401");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("fails after exhausting all retries", async () => {
    vi.useFakeTimers();
    fetchSpy
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(errorResponse(503));

    const provider = new NvidiaNimProvider({
      apiKey: "test-key",
    });

    const promise = provider.embed(["test"]).catch((e) => e);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);

    const error = await promise;
    expect(error).toBeInstanceOf(NimApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    vi.useRealTimers();
  });

  it("embedSingle delegates to embed", async () => {
    fetchSpy.mockResolvedValueOnce(
      okResponse({
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      }),
    );

    const provider = new NvidiaNimProvider({
      apiKey: "test-key",
      dimensions: 3,
    });
    const result = await provider.embedSingle("hello");

    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.input).toEqual(["hello"]);
  });

  it("returns empty array for empty input", async () => {
    const provider = new NvidiaNimProvider({ apiKey: "test-key" });
    const result = await provider.embed([]);
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses custom baseUrl and model from config", async () => {
    fetchSpy.mockResolvedValueOnce(okResponse(mockEmbeddingResponse(1, 2)));

    const provider = new NvidiaNimProvider({
      apiKey: "test-key",
      baseUrl: "https://custom.api.com/v1/embeddings",
      model: "custom/model",
      dimensions: 2,
    });
    await provider.embed(["test"]);

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.api.com/v1/embeddings");

    const body = JSON.parse(opts.body as string);
    expect(body.model).toBe("custom/model");
  });
});
