import { execFile } from "node:child_process";
import OpenAI from "openai";

import { config, requireLlmApiKey } from "./config";

export interface SmhlChallenge {
  targetAsciiSum: number;
  firstNChars: number;
  wordCount: number;
  charPosition: number;
  charValue: number;
  totalLength: number;
}

export function normalizeSmhlChallenge(raw: unknown): SmhlChallenge {
  if (Array.isArray(raw)) {
    const [targetAsciiSum, firstNChars, wordCount, charPosition, charValue, totalLength] = raw;
    return {
      targetAsciiSum: Number(targetAsciiSum),
      firstNChars: Number(firstNChars),
      wordCount: Number(wordCount),
      charPosition: Number(charPosition),
      charValue: Number(charValue),
      totalLength: Number(totalLength),
    };
  }

  if (raw && typeof raw === "object") {
    const challenge = raw as Record<string, unknown>;
    return {
      targetAsciiSum: Number(challenge.targetAsciiSum),
      firstNChars: Number(challenge.firstNChars),
      wordCount: Number(challenge.wordCount),
      charPosition: Number(challenge.charPosition),
      charValue: Number(challenge.charValue),
      totalLength: Number(challenge.totalLength),
    };
  }

  throw new Error("Unable to normalize SMHL challenge.");
}

export function buildSmhlPrompt(challenge: SmhlChallenge): string {
  const requiredChar = String.fromCharCode(challenge.charValue);
  const minLen = challenge.totalLength - 5;
  const maxLen = challenge.totalLength + 5;

  return [
    `Write a sentence between ${minLen} and ${maxLen} characters long (including spaces) with about ${challenge.wordCount} words.`,
    `It must contain the letter '${requiredChar}'.`,
    `Output ONLY the sentence. No quotes, no explanation.`,
  ].join("\n");
}

export function validateSmhlSolution(solution: string, challenge: SmhlChallenge): string[] {
  const issues: string[] = [];

  if (!solution) {
    issues.push("empty response");
    return issues;
  }

  const len = Buffer.byteLength(solution, "utf8");
  if (Math.abs(len - challenge.totalLength) > 5) {
    issues.push(`length ${len} not within ±5 of ${challenge.totalLength}`);
  }

  if (!/^[\x20-\x7E]+$/.test(solution)) {
    issues.push("solution must use printable ASCII only");
  }

  const requiredChar = String.fromCharCode(challenge.charValue);
  if (!solution.includes(requiredChar)) {
    issues.push(`missing required char '${requiredChar}'`);
  }

  const words = solution.split(" ").filter(Boolean);
  if (Math.abs(words.length - challenge.wordCount) > 2) {
    issues.push(`word count ${words.length} not within ±2 of ${challenge.wordCount}`);
  }

  return issues;
}

function sanitizeResponse(text: string): string {
  let cleaned = text.replace(/\r/g, "").trim();

  const fenceMatch = cleaned.match(/^```(?:text)?\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    cleaned = fenceMatch[1];
  }

  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }

  return cleaned;
}

async function requestOpenAiSolution(prompt: string): Promise<string> {
  const client = new OpenAI({ apiKey: requireLlmApiKey() });
  const response = await client.chat.completions.create({
    model: config.llmModel,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You solve constrained ASCII string generation tasks. Return only the exact string requested.",
      },
      { role: "user", content: prompt },
    ],
  }, { timeout: 15_000 });

  return response.choices[0]?.message.content ?? "";
}

async function requestAnthropicSolution(prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "x-api-key": requireLlmApiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: 200,
      temperature: 0,
      system:
        "You solve constrained ASCII string generation tasks. Return only the exact string requested.",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
    await new Promise((r) => setTimeout(r, waitMs));
    throw new Error(`Rate limited by Anthropic — retrying`);
  }

  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  return data.content?.find((item) => item.type === "text")?.text ?? "";
}

async function requestOllamaSolution(prompt: string): Promise<string> {
  const response = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.llmModel,
      prompt: [
        "You solve constrained ASCII string generation tasks.",
        "Return only the exact string requested.",
        "",
        prompt,
      ].join("\n"),
      stream: false,
      options: { temperature: 0 },
    }),
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
    await new Promise((r) => setTimeout(r, waitMs));
    throw new Error(`Rate limited by Ollama — retrying`);
  }

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { response?: string };
  return data.response ?? "";
}

async function requestGeminiSolution(prompt: string): Promise<string> {
  const model = config.llmModel || "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${requireLlmApiKey()}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "You solve constrained ASCII string generation tasks. Return only the exact string requested." }],
        },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      }),
    },
  );

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
    await new Promise((r) => setTimeout(r, waitMs));
    throw new Error(`Rate limited by Gemini — retrying`);
  }

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function requestClaudeCodeSolution(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["-p", prompt, "--no-input"], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Claude Code error: ${error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function requestCodexSolution(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("codex", ["exec", prompt, "--full-auto"], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Codex error: ${error.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function requestProviderSolution(prompt: string): Promise<string> {
  switch (config.llmProvider) {
    case "anthropic":
      return requestAnthropicSolution(prompt);
    case "gemini":
      return requestGeminiSolution(prompt);
    case "ollama":
      return requestOllamaSolution(prompt);
    case "claude-code":
      return requestClaudeCodeSolution(prompt);
    case "codex":
      return requestCodexSolution(prompt);
    case "openai":
    default:
      return requestOpenAiSolution(prompt);
  }
}

export async function solveSmhlChallenge(
  challenge: SmhlChallenge,
  onAttempt?: (attempt: number) => void,
): Promise<string> {
  const prompt = buildSmhlPrompt(challenge);
  let lastIssues = "provider did not return a valid response";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (onAttempt) onAttempt(attempt);
    const raw = await requestProviderSolution(prompt);
    const candidate = sanitizeResponse(raw);
    const issues = validateSmhlSolution(candidate, challenge);

    if (issues.length === 0) {
      return candidate;
    }

    lastIssues = `attempt ${attempt}: ${issues.join(", ")}`;
  }

  throw new Error(`SMHL solve failed after 3 attempts: ${lastIssues}`);
}
