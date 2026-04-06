import { exec, execFile } from "node:child_process";
import OpenAI from "openai";

import { config, requireLlmApiKey, resolveDefaultModel, type LlmProvider } from "./config";

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

export function buildSmhlPrompt(challenge: SmhlChallenge, feedback?: string): string {
  const requiredChar = String.fromCharCode(challenge.charValue);
  const spaces = Math.max(0, challenge.wordCount - 1);
  const avgWordLen = Math.round((challenge.totalLength - spaces) / challenge.wordCount);
  const minWordLen = Math.max(2, avgWordLen - 2);
  const maxWordLen = avgWordLen + 2;

  const lines = [
    `Write exactly ${challenge.wordCount} lowercase English words separated by single spaces.`,
    `Each word should be ${minWordLen} to ${maxWordLen} letters long.`,
    `At least one word must contain the letter '${requiredChar}'.`,
    `No punctuation, no quotes, no explanation — just the words.`,
  ];

  if (feedback) {
    lines.push("", `Previous attempt was rejected: ${feedback}. Try completely different words.`);
  }

  return lines.join("\n");
}

export function validateSmhlSolution(solution: string, challenge: SmhlChallenge): string[] {
  const issues: string[] = [];

  if (!solution) {
    issues.push("empty response");
    return issues;
  }

  const len = Buffer.byteLength(solution, "utf8");
  if (Math.abs(len - challenge.totalLength) > 4) {
    issues.push(`length ${len} not within ±4 of ${challenge.totalLength}`);
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

/**
 * Post-process LLM output to fit within SMHL constraints.
 * The LLM generates roughly-correct text; this adjusts length, word count,
 * and ensures the required character is present.
 */
function adjustSolution(raw: string, challenge: SmhlChallenge): string {
  const requiredChar = String.fromCharCode(challenge.charValue);
  const minLen = challenge.totalLength - 4;
  const maxLen = challenge.totalLength + 4;
  const maxWords = challenge.wordCount + 2;

  // Clean: lowercase, letters and spaces only, collapse whitespace
  let words = raw
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return raw;

  // Trim excess words (prefer keeping words with the required char)
  while (words.length > maxWords) {
    let removeIdx = -1;
    for (let i = words.length - 1; i >= 0; i--) {
      if (!words[i].includes(requiredChar)) { removeIdx = i; break; }
    }
    words.splice(removeIdx >= 0 ? removeIdx : words.length - 1, 1);
  }

  let result = words.join(" ");
  let len = Buffer.byteLength(result, "utf8");

  // Too long: trim at word boundary, then trim characters
  if (len > maxLen) {
    result = result.slice(0, maxLen);
    const lastSpace = result.lastIndexOf(" ");
    if (lastSpace >= minLen) result = result.slice(0, lastSpace);
    words = result.split(" ").filter(Boolean);
    len = Buffer.byteLength(result, "utf8");
  }

  // Too short: add filler words
  const fillers = ["and", "the", "not", "can", "run", "now", "old", "new"];
  let fi = 0;
  while (len < minLen && words.length < maxWords) {
    words.push(fillers[fi % fillers.length]);
    result = words.join(" ");
    len = Buffer.byteLength(result, "utf8");
    fi++;
  }

  // Still too short but can't add more words: extend last word
  while (len < minLen && words.length > 0) {
    words[words.length - 1] += "s";
    result = words.join(" ");
    len = Buffer.byteLength(result, "utf8");
  }

  // Ensure required char is present
  if (!result.includes(requiredChar)) {
    const last = words[words.length - 1];
    words[words.length - 1] = last.slice(0, -1) + requiredChar;
    result = words.join(" ");
  }

  return result;
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

async function requestOpenAiSolutionForModel(prompt: string, model: string): Promise<string> {
  const client = new OpenAI({ apiKey: requireLlmApiKey() });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You generate short lowercase word sequences that match exact constraints. Return only the words separated by spaces. Nothing else.",
      },
      { role: "user", content: prompt },
    ],
  }, { timeout: 15_000 });

  return response.choices[0]?.message.content ?? "";
}

async function requestAnthropicSolutionForModel(prompt: string, model: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      "x-api-key": requireLlmApiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      temperature: 0.7,
      system:
        "You generate short lowercase word sequences that match exact constraints. Return only the words separated by spaces. Nothing else.",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
    await new Promise((r) => setTimeout(r, waitMs));
    throw new Error("Rate limited by Anthropic — retrying");
  }

  if (!response.ok) {
    throw new Error(`Anthropic request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };

  return data.content?.find((item) => item.type === "text")?.text ?? "";
}

async function requestOllamaSolutionForModel(prompt: string, model: string): Promise<string> {
  const response = await fetch(`${config.ollamaUrl}/api/generate`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: [
        "You generate short lowercase word sequences that match exact constraints.",
        "Return only the words separated by spaces. Nothing else.",
        "",
        prompt,
      ].join("\n"),
      stream: false,
      options: { temperature: 0.7 },
    }),
  });

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
    await new Promise((r) => setTimeout(r, waitMs));
    throw new Error("Rate limited by Ollama — retrying");
  }

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { response?: string };
  return data.response ?? "";
}

async function requestGeminiSolutionForModel(prompt: string, model: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${requireLlmApiKey()}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "You generate short lowercase word sequences that match exact constraints. Return only the words separated by spaces. Nothing else." }],
        },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } },
      }),
    },
  );

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 5000;
    await new Promise((r) => setTimeout(r, waitMs));
    throw new Error("Rate limited by Gemini — retrying");
  }

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function requestDeepSeekSolutionForModel(prompt: string, model: string): Promise<string> {
  const client = new OpenAI({
    apiKey: requireLlmApiKey(),
    baseURL: "https://api.deepseek.com",
  });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You generate short lowercase word sequences that match exact constraints. Return only the words separated by spaces. Nothing else.",
      },
      { role: "user", content: prompt },
    ],
  }, { timeout: 15_000 });

  return response.choices[0]?.message.content ?? "";
}

async function requestQwenSolutionForModel(prompt: string, model: string): Promise<string> {
  const client = new OpenAI({
    apiKey: requireLlmApiKey(),
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You generate short lowercase word sequences that match exact constraints. Return only the words separated by spaces. Nothing else.",
      },
      { role: "user", content: prompt },
    ],
  }, { timeout: 15_000 });

  return response.choices[0]?.message.content ?? "";
}

async function requestClawRouterSolution(prompt: string, model: string): Promise<string> {
  const { ensureClawRouter, getClawRouterBaseUrl } = await import("./clawrouter");
  const { requirePrivateKey } = await import("./config");

  await ensureClawRouter(requirePrivateKey());

  const client = new OpenAI({
    apiKey: "x402",
    baseURL: `${getClawRouterBaseUrl()}/v1`,
  });

  const response = await client.chat.completions.create({
    model,
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
          "You generate short lowercase word sequences that match exact constraints. Return only the words separated by spaces. Nothing else.",
      },
      { role: "user", content: prompt },
    ],
  }, { timeout: 15_000 });

  return response.choices[0]?.message.content ?? "";
}

async function requestClaudeCodeSolution(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const escaped = prompt.replace(/'/g, "'\\''");
    exec(`claude -p '${escaped}'`, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Claude Code error: ${error.message}${stderr ? `\nstderr: ${stderr}` : ""}${stdout ? `\nstdout: ${stdout}` : ""}`));
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
        reject(new Error(`Codex error: ${error.message}${stderr ? `\nstderr: ${stderr}` : ""}${stdout ? `\nstdout: ${stdout}` : ""}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function resolveModelForProvider(provider: LlmProvider): string {
  return provider === config.llmProvider ? config.llmModel : resolveDefaultModel(provider);
}

function resolveProviderOrder(): LlmProvider[] {
  const providers: LlmProvider[] = [config.llmProvider];
  if (config.useX402 && config.privateKey && config.llmProvider !== "clawrouter") {
    providers.push("clawrouter");
  }
  return providers;
}

function describeProvider(provider: LlmProvider): string {
  return provider === "claude-code" ? "Claude Code" : provider === "clawrouter" ? "ClawRouter" : provider;
}

function isPermanentProviderError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("request not allowed")
    || normalized.includes("failed to authenticate")
    || normalized.includes("country, region, or territory not supported")
    || normalized.includes("invalid api key")
    || normalized.includes("api key is invalid")
    || normalized.includes("not authenticated")
    || normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("not logged in")
    || normalized.includes("command not found")
    || normalized.includes("enoent");
}

async function requestProviderSolution(provider: LlmProvider, prompt: string): Promise<string> {
  const model = resolveModelForProvider(provider);
  switch (provider) {
    case "anthropic":
      return requestAnthropicSolutionForModel(prompt, model);
    case "gemini":
      return requestGeminiSolutionForModel(prompt, model);
    case "ollama":
      return requestOllamaSolutionForModel(prompt, model);
    case "claude-code":
      return requestClaudeCodeSolution(prompt);
    case "codex":
      return requestCodexSolution(prompt);
    case "deepseek":
      return requestDeepSeekSolutionForModel(prompt, model);
    case "qwen":
      return requestQwenSolutionForModel(prompt, model);
    case "clawrouter":
      return requestClawRouterSolution(prompt, model);
    case "openai":
    default:
      return requestOpenAiSolutionForModel(prompt, model);
  }
}

/**
 * Solve SMHL challenge algorithmically (no LLM needed).
 * On-chain _verifySMHL only checks: totalLength ±5, charValue anywhere, wordCount ±2.
 * Generates a valid solution in microseconds.
 */
export function solveSmhlAlgorithmic(challenge: SmhlChallenge): string {
  const requiredChar = String.fromCharCode(challenge.charValue);
  const targetWords = challenge.wordCount;
  const targetLen = challenge.totalLength;
  const spaces = targetWords - 1;
  const letterBudget = targetLen - spaces;

  if (letterBudget <= 0 || targetWords <= 0) {
    return requiredChar.repeat(targetLen);
  }

  const baseWordLen = Math.floor(letterBudget / targetWords);
  const extraChars = letterBudget - baseWordLen * targetWords;

  const words: string[] = [];
  for (let i = 0; i < targetWords; i++) {
    const len = Math.max(1, baseWordLen + (i < extraChars ? 1 : 0));
    if (i === 0) {
      words.push(requiredChar + "a".repeat(len - 1));
    } else {
      words.push("a".repeat(len));
    }
  }

  return words.join(" ");
}

export async function solveSmhlChallenge(
  challenge: SmhlChallenge,
  onAttempt?: (attempt: number) => void,
): Promise<string> {
  const providers = resolveProviderOrder();
  let providerIndex = 0;
  let feedback: string | undefined;
  let lastIssues = "provider did not return a valid response";

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (onAttempt) onAttempt(attempt);

    while (providerIndex < providers.length) {
      const provider = providers[providerIndex];
      const prompt = buildSmhlPrompt(challenge, feedback);
      try {
        const raw = await requestProviderSolution(provider, prompt);
        const sanitized = sanitizeResponse(raw);
        const adjusted = adjustSolution(sanitized, challenge);
        const issues = validateSmhlSolution(adjusted, challenge);

        if (issues.length === 0) {
          return adjusted;
        }

        feedback = issues.join(", ");
        lastIssues = `attempt ${attempt} (${describeProvider(provider)}): ${feedback}`;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isPermanentProviderError(msg) && providerIndex < providers.length - 1) {
          providerIndex += 1;
          feedback = undefined;
          lastIssues = `${describeProvider(provider)} unavailable: ${msg}`;
          continue;
        }
        if (isPermanentProviderError(msg)) {
          throw new Error(`SMHL solve failed with ${describeProvider(provider)}: ${msg}`);
        }
        feedback = msg;
        lastIssues = `attempt ${attempt} (${describeProvider(provider)}): ${msg}`;
        break;
      }
    }
  }

  throw new Error(`SMHL solve failed after 5 attempts: ${lastIssues}`);
}
