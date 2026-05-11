import type { Atom } from "../core/types.js";
import { cosineSimilarity } from "../core/act-r.js";

const SENT_SPLIT =
  /(?<=[.!?])\s+(?=[A-Z])|(?<=\n)\s*(?=\d+[.):]\s)|(?<=\n)\s*(?=[-*\u2022]\s)|(?<=\n)\s*(?=#{1,6}\s)|\n{2,}/;

function splitSentences(text: string): string[] {
  if (!text?.trim()) return [];
  const segments = text.trim().split(SENT_SPLIT);
  const result: string[] = [];
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed.length >= 8) result.push(trimmed);
  }
  if (result.length === 0 && text.trim()) {
    result.push(text.trim());
  }
  return result;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function compressContext(atoms: Atom[], tokenBudget: number): string {
  if (atoms.length === 0) return "";

  const allSentences: Array<{
    atomId: string;
    text: string;
    tokens: number;
  }> = [];

  for (const atom of atoms) {
    const sentences = splitSentences(atom.content);
    for (const sent of sentences) {
      allSentences.push({
        atomId: atom.id,
        text: sent,
        tokens: estimateTokens(sent),
      });
    }
  }

  if (allSentences.length === 0) return "";

  const codebook = buildCodebook(allSentences.map((s) => s.text));

  const compressed = allSentences.map((s) => ({
    ...s,
    text: applyCodebook(s.text, codebook),
    tokens: estimateTokens(applyCodebook(s.text, codebook)),
  }));

  const deduped = semanticDedup(compressed, 0.75);

  const selected: typeof deduped = [];
  let tokensUsed = 0;

  for (const sent of deduped) {
    if (tokensUsed + sent.tokens > tokenBudget) {
      if (selected.length === 0) {
        selected.push(sent);
        tokensUsed += sent.tokens;
      }
      break;
    }
    selected.push(sent);
    tokensUsed += sent.tokens;
  }

  return selected.map((s) => s.text).join(" ");
}

function buildCodebook(
  sentences: string[],
): Map<string, string> {
  const entityCounts = new Map<string, number>();
  const entityPattern =
    /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;

  for (const sent of sentences) {
    const matches = sent.match(entityPattern);
    if (matches) {
      for (const m of matches) {
        entityCounts.set(m, (entityCounts.get(m) || 0) + 1);
      }
    }
  }

  const codebook = new Map<string, string>();
  const sorted = Array.from(entityCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  let abbrevIdx = 0;
  for (const [entity] of sorted) {
    if (entity.length > 6) {
      const abbrev = entity
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .toUpperCase();
      const key = abbrevIdx > 0 ? `${abbrev}${abbrevIdx}` : abbrev;
      codebook.set(entity, key);
      abbrevIdx++;
    }
  }

  return codebook;
}

function applyCodebook(text: string, codebook: Map<string, string>): string {
  let result = text;
  for (const [entity, abbrev] of codebook) {
    result = result.replaceAll(entity, abbrev);
  }
  return result;
}

function semanticDedup(
  sentences: Array<{ atomId: string; text: string; tokens: number }>,
  threshold: number,
): Array<{ atomId: string; text: string; tokens: number }> {
  if (sentences.length <= 1) return sentences;

  const removed = new Set<number>();

  for (let i = 0; i < sentences.length; i++) {
    if (removed.has(i)) continue;
    for (let j = i + 1; j < sentences.length; j++) {
      if (removed.has(j)) continue;
      const sim = textSimilarity(sentences[i].text, sentences[j].text);
      if (sim >= threshold) {
        const keepI = sentences[i].text.length >= sentences[j].text.length;
        removed.add(keepI ? j : i);
        if (!keepI) break;
      }
    }
  }

  return sentences.filter((_, idx) => !removed.has(idx));
}

function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  return intersection / Math.max(wordsA.size, wordsB.size);
}

export { splitSentences, estimateTokens, buildCodebook, applyCodebook, semanticDedup };
