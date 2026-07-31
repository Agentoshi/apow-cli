import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { StringDecoder } from "node:string_decoder";

const isTTY = !!stdout.isTTY && !!stderr.isTTY;
const isInteractive = !!stdin.isTTY && isTTY;
const noColor = !!process.env.NO_COLOR || !isTTY;

export function isInteractiveSession(): boolean {
  return isInteractive;
}

function wrap(code: number, reset: number): (s: string) => string {
  if (noColor) return (s) => s;
  return (s) => `\x1b[${code}m${s}\x1b[${reset}m`;
}

function wrapRgb(red: number, green: number, blue: number): (s: string) => string {
  if (noColor) return (s) => s;
  return (s) => `\x1b[38;2;${red};${green};${blue}m${s}\x1b[39m`;
}

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrapRgb(252, 64, 31);
export const green = wrapRgb(102, 200, 0);
export const yellow = wrapRgb(255, 209, 47);
export const cyan = wrapRgb(77, 159, 255);
export const baseBlue = wrapRgb(0, 82, 255);

export function banner(lines: string[]): void {
  if (!lines.length) return;
  const maxLen = Math.max(...lines.map((l) => l.length));
  const pad = (s: string) => s + " ".repeat(maxLen - s.length);
  const border = `+${"-".repeat(maxLen + 2)}+`;
  console.log(`  ${baseBlue(border)}`);
  for (const line of lines) {
    console.log(`  ${baseBlue("|")} ${bold(pad(line))} ${baseBlue("|")}`);
  }
  console.log(`  ${baseBlue(border)}`);
}

export function table(rows: [string, string][]): void {
  const maxKey = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) {
    console.log(`    ${dim(key + ":")}${" ".repeat(maxKey - key.length + 2)}${value}`);
  }
}

export interface Spinner {
  update(label: string): void;
  stop(finalLabel: string): void;
  fail(label: string): void;
}

const activeSpinners = new Set<Spinner>();

export function spinner(label: string): Spinner {
  if (!isTTY) {
    console.error(`  ${label}`);
    let finished = false;
    const noop: Spinner = {
      update() {},
      stop(l) {
        if (finished) return;
        finished = true;
        console.error(`  ${l}`);
      },
      fail(l) {
        if (finished) return;
        finished = true;
        console.error(`  ${l}`);
      },
    };
    return noop;
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  let current = label;
  let stopped = false;

  const render = () => {
    if (stopped) return;
    stderr.write(`\r  ${cyan(frames[frame % frames.length])} ${current}  \x1b[K`);
    frame++;
  };

  const interval = setInterval(render, 80);
  render();

  const s: Spinner = {
    update(l) {
      current = l;
    },
    stop(finalLabel) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      stderr.write(`\r  ${green("✔")} ${finalLabel}\x1b[K\n`);
      activeSpinners.delete(s);
    },
    fail(failLabel) {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      stderr.write(`\r  ${red("✖")} ${failLabel}\x1b[K\n`);
      activeSpinners.delete(s);
    },
  };

  activeSpinners.add(s);
  return s;
}

export function stopAll(): void {
  for (const s of activeSpinners) {
    s.fail("interrupted");
  }
  activeSpinners.clear();
}

export async function confirm(question: string): Promise<boolean> {
  if (!isInteractive) return false;
  const rl = createInterface({ input: stdin, output: stderr });
  const answer = await rl.question(`  ${question} ${dim("(y/N)")} `);
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
}

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  if (!isInteractive) {
    return defaultValue ?? "";
  }
  const rl = createInterface({ input: stdin, output: stderr });
  const hint = defaultValue ? ` ${dim(`[${defaultValue}`)}${dim("]")}` : "";
  const answer = await rl.question(`  ${question}${hint}: `);
  rl.close();
  return answer.trim() || defaultValue || "";
}

export async function promptSecret(question: string): Promise<string> {
  if (!isInteractive) {
    return "";
  }
  return readMaskedInput(`  ${question}: `);
}

type MaskedInputStream = NodeJS.ReadableStream & {
  isRaw?: boolean;
  readableFlowing?: boolean | null;
  setRawMode?: (mode: boolean) => void;
};

type MaskedOutputStream = Pick<NodeJS.WritableStream, "write">;

/**
 * Read one secret value while rendering one asterisk per typed character.
 * Exported for regression testing; interactive callers should use promptSecret().
 */
export function readMaskedInput(
  promptText: string,
  input: MaskedInputStream = stdin,
  output: MaskedOutputStream = stderr,
): Promise<string> {
  output.write(promptText);

  return new Promise<string>((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const characters: string[] = [];
    const wasRaw = input.isRaw === true;
    const wasFlowing = input.readableFlowing === true;
    let escapeState: "none" | "start" | "csi" | "ss3" = "none";
    let settled = false;

    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("error", onError);
      if (input.setRawMode) {
        try {
          input.setRawMode(wasRaw);
        } catch {
          // The stream may have closed while the prompt was active.
        }
      }
      if (!wasFlowing) {
        input.pause();
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      resolve(characters.join("").trim());
    };

    const interrupt = () => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      const error = Object.assign(new Error("Secret input interrupted."), { code: "SIGINT" });
      reject(error);
      process.kill(process.pid, "SIGINT");
    };

    const eraseCharacter = () => {
      if (characters.length === 0) return;
      characters.pop();
      output.write("\b \b");
    };

    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);

      for (const character of text) {
        if (escapeState === "start") {
          escapeState = character === "[" ? "csi" : character === "O" ? "ss3" : "none";
          continue;
        }
        if (escapeState === "csi") {
          const code = character.codePointAt(0) ?? 0;
          if (code >= 0x40 && code <= 0x7e) escapeState = "none";
          continue;
        }
        if (escapeState === "ss3") {
          escapeState = "none";
          continue;
        }

        if (character === "\u001b") {
          escapeState = "start";
          continue;
        }
        if (character === "\r" || character === "\n") {
          finish();
          break;
        }
        if (character === "\u0003") {
          interrupt();
          break;
        }
        if (character === "\u007f" || character === "\b") {
          eraseCharacter();
          continue;
        }
        if (character === "\u0015") {
          while (characters.length > 0) eraseCharacter();
          continue;
        }

        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) continue;
        characters.push(character);
        output.write("*");
      }
    };

    const onEnd = () => finish();
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      reject(error);
    };

    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);

    try {
      input.setRawMode?.(true);
      input.resume();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function ok(label: string): void {
  console.log(`  ${green("[OK]")} ${label}`);
}

export function fail(label: string): void {
  console.log(`  ${red("[X]")} ${label}`);
}

export function hint(message: string): void {
  console.log(`       ${dim(message)}`);
}

export function error(message: string): void {
  console.error(`  ${red("Error:")} ${message}`);
}

export function warn(message: string): void {
  console.log(`  ${yellow("Warning:")} ${message}`);
}

export function info(label: string, value: string): void {
  console.log(`  ${label} ${value}`);
}
