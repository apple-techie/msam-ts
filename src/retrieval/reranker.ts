import { getConfigValue } from "../config/index.js";
import type { ScoredAtom } from "./strategies.js";

export async function rerankWithLlm(
  query: string,
  atoms: ScoredAtom[],
  topK: number = 5,
): Promise<ScoredAtom[]> {
  const model = getConfigValue(
    "retrieval_v2",
    "rerank_model",
    "mistralai/mistral-large-3-675b-instruct-2512",
  );
  const apiKey = process.env.NVIDIA_NIM_API_KEY;

  if (!apiKey || atoms.length <= 1) {
    return atoms.slice(0, topK);
  }

  const candidates = atoms.slice(0, Math.min(8, atoms.length));

  const passagesText = candidates
    .map((a, i) => `${i}: ${a.atom.content.slice(0, 150)}`)
    .join("\n");

  const prompt = `Rank these passages by relevance to the query. Return ONLY the indices in order, most relevant first. No explanation.

Query: ${query}

Passages:
${passagesText}

Ranking:`;

  try {
    const resp = await fetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 30,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (resp.ok) {
      const json = (await resp.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const rankingText = json.choices[0].message.content.trim();

      const indices: number[] = [];
      for (const match of rankingText.matchAll(/\d+/g)) {
        const idx = parseInt(match[0], 10);
        if (idx < candidates.length && !indices.includes(idx)) {
          indices.push(idx);
        }
      }

      if (indices.length > 0) {
        const reranked: ScoredAtom[] = [];
        for (let rank = 0; rank < Math.min(indices.length, topK); rank++) {
          reranked.push({
            ...candidates[indices[rank]],
            reranked: true,
            originalRank: indices[rank],
          });
        }

        const rerankedIds = new Set(reranked.map((a) => a.atom.id));
        for (const a of atoms) {
          if (!rerankedIds.has(a.atom.id) && reranked.length < topK) {
            reranked.push(a);
          }
        }

        return reranked.slice(0, topK);
      }
    }
  } catch {
    // Fall through to original ordering
  }

  return atoms.slice(0, topK);
}
