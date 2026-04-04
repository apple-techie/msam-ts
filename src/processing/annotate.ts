import { getConfig } from "../config/index.js";

export interface Annotations {
  topics: string[];
  arousal: number;
  valence: number;
  sourceType: string;
  encodingConfidence: number;
  stream?: string;
}

const HIGH_AROUSAL_PATTERNS = [
  /\b(urgent|emergency|critical|panic|terrified|furious|ecstatic|thrilled)\b/gi,
  /[!]{2,}/g,
  /[A-Z]{4,}/g,
  /\b(love|hate|angry|scared|excited|amazing|terrible|horrible)\b/gi,
];

const POSITIVE_PATTERNS = [
  /\b(love|happy|great|amazing|wonderful|excellent|perfect|beautiful|grateful|proud)\b/gi,
  /\b(excited|thrilled|glad|pleased|enjoy|fun|awesome|fantastic)\b/gi,
];

const NEGATIVE_PATTERNS = [
  /\b(hate|sad|angry|terrible|horrible|awful|worst|disappointed|frustrated|upset)\b/gi,
  /\b(scared|afraid|worried|anxious|stressed|painful|hurts|miss|lonely)\b/gi,
];

const TOPIC_PATTERNS: Record<string, RegExp> = {
  health: /\b(sleep|tired|rest|sick|pain|injury|doctor|medicine|eat|hydrat)\w*\b/i,
  work: /\b(work|job|career|project|task|deadline|meeting|schedule)\w*\b/i,
  technology: /\b(code|program|server|api|database|deploy|bug|config|system)\w*\b/i,
  relationship: /\b(friend|family|partner|trust|together|support|care|miss)\w*\b/i,
  entertainment: /\b(movie|anime|music|game|watch|play|listen|read|book)\w*\b/i,
  travel: /\b(hotel|flight|city|travel|tour|venue|airport)\w*\b/i,
  memory: /\b(remember|forgot|memory|recall|remind)\w*\b/i,
  emotion: /\b(feel|emotion|mood|happy|sad|angry|scared|love|hate)\w*\b/i,
};

function countMatches(text: string, patterns: RegExp[]): number {
  let total = 0;
  for (const p of patterns) {
    const matches = text.match(new RegExp(p.source, p.flags));
    total += matches?.length ?? 0;
  }
  return total;
}

function heuristicAnnotate(content: string): Annotations {
  const lower = content.toLowerCase();

  const arousalHits = countMatches(content, HIGH_AROUSAL_PATTERNS);
  const arousal = Math.min(0.3 + arousalHits * 0.15, 1.0);

  const posHits = countMatches(lower, POSITIVE_PATTERNS);
  const negHits = countMatches(lower, NEGATIVE_PATTERNS);
  const totalVal = posHits + negHits;
  const valence = totalVal > 0 ? (posHits - negHits) / totalVal : 0.0;

  const topics: string[] = [];
  for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS)) {
    if (pattern.test(lower)) {
      topics.push(topic);
    }
  }

  return {
    topics: topics.slice(0, 5),
    arousal: Math.round(arousal * 100) / 100,
    valence: Math.round(valence * 100) / 100,
    sourceType: "conversation",
    encodingConfidence: 0.5,
  };
}

function classifyStream(content: string): string {
  const lower = content.toLowerCase();

  const proceduralPatterns = [
    /\bhow to\b/,
    /\bstep 1\b/,
    /\bcommand:/,
    /(?<!\w)run /,
    /\bexecute\b/,
    /\bconfig\b/,
    /\binstall\b/,
    /\bworkflow\b/,
    /\balways\b/,
    /\bnever\b/,
    /\brule:/,
  ];
  if (proceduralPatterns.some((p) => p.test(lower))) return "procedural";

  if (/\bif\b.{1,40}\bthen\b/.test(lower)) return "procedural";
  if (/\bwhen\b.{1,40}\b(do|use|run|check|always)\b/.test(lower)) return "procedural";

  const episodicKeywords = [
    "today",
    "yesterday",
    "last night",
    "this morning",
    "we talked",
    "happened",
    "said that",
    "user said",
    "we decided",
    "discussed",
    "mentioned",
    "watched",
    "went to",
    "deployed",
    "tested",
    "fixed",
    "recently",
    "this week",
    "last week",
  ];
  if (episodicKeywords.some((kw) => lower.includes(kw))) return "episodic";

  if (/\b\d{4}-\d{2}-\d{2}\b/.test(lower)) return "episodic";
  if (/\bat \d{1,2}:\d{2}\b/.test(lower)) return "episodic";

  return "semantic";
}

const LLM_ANNOTATION_PROMPT = `Analyze the following text and return a JSON object with these fields:
- arousal: float 0.0 to 1.0 (emotional intensity)
- valence: float -1.0 to 1.0 (negative to positive sentiment)
- topics: list of up to 5 topic strings
- stream: one of "semantic", "episodic", "procedural"
- encoding_confidence: float 0.0 to 1.0 (how confident you are in this analysis)

Return ONLY valid JSON, no explanation.

Text: {content}`;

async function llmAnnotate(content: string): Promise<Annotations> {
  const config = getConfig();
  const annotation = config.annotation;
  const apiKeyEnv = annotation.api_key_env;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;

  if (!apiKey) {
    return heuristicAnnotate(content);
  }

  const prompt = LLM_ANNOTATION_PROMPT.replace("{content}", content.slice(0, 2000));

  try {
    const { request } = await import("undici");
    const resp = await request(annotation.llm_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: annotation.llm_model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 500,
      }),
    });

    if (resp.statusCode !== 200) {
      return heuristicAnnotate(content);
    }

    const data = (await resp.body.json()) as any;
    let text = data?.choices?.[0]?.message?.content?.trim() ?? "";

    if (text.startsWith("```")) {
      text = text.split("\n").slice(1).join("\n");
      if (text.endsWith("```")) text = text.slice(0, -3);
      text = text.trim();
    }

    const parsed = JSON.parse(text);

    const arousal = Math.max(0.0, Math.min(1.0, Number(parsed.arousal ?? 0.5)));
    const valence = Math.max(-1.0, Math.min(1.0, Number(parsed.valence ?? 0.0)));
    const encodingConfidence = Math.max(
      0.0,
      Math.min(1.0, Number(parsed.encoding_confidence ?? 0.7)),
    );

    let topics = parsed.topics ?? [];
    if (!Array.isArray(topics)) topics = [];
    topics = topics.slice(0, 5).map(String);

    let stream = parsed.stream ?? "semantic";
    if (!["semantic", "episodic", "procedural"].includes(stream)) {
      stream = "semantic";
    }

    return {
      topics,
      arousal: Math.round(arousal * 100) / 100,
      valence: Math.round(valence * 100) / 100,
      sourceType: "conversation",
      encodingConfidence: Math.round(encodingConfidence * 100) / 100,
      stream,
    };
  } catch {
    return heuristicAnnotate(content);
  }
}

export async function annotateContent(
  content: string,
  useLlm?: boolean,
): Promise<Annotations> {
  if (useLlm) {
    return llmAnnotate(content);
  }
  return heuristicAnnotate(content);
}

export { heuristicAnnotate, llmAnnotate, classifyStream };
