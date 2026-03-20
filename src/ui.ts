import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

const isTTY = stdout.isTTY && stderr.isTTY;
const noColor = !!process.env.NO_COLOR || !isTTY;

function wrap(code: number, reset: number): (s: string) => string {
  if (noColor) return (s) => s;
  return (s) => `\x1b[${code}m${s}\x1b[${reset}m`;
}

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

export function banner(lines: string[]): void {
  if (!lines.length) return;
  const maxLen = Math.max(...lines.map((l) => l.length));
  const pad = (s: string) => s + " ".repeat(maxLen - s.length);
  const border = "=".repeat(maxLen + 4);
  console.log(`  ${dim(border)}`);
  for (const line of lines) {
    console.log(`   ${pad(line)}`);
  }
  console.log(`  ${dim(border)}`);
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
    const noop: Spinner = {
      update(l) { console.error(`  ${l}`); },
      stop(l) { console.error(`  ${l}`); },
      fail(l) { console.error(`  ${l}`); },
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
  if (!isTTY) return true;
  const rl = createInterface({ input: stdin, output: stderr });
  const answer = await rl.question(`  ${question} ${dim("(Y/n)")} `);
  rl.close();
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "" || trimmed === "y" || trimmed === "yes";
}

export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr });
  const hint = defaultValue ? ` ${dim(`[${defaultValue}`)}${dim("]")}` : "";
  const answer = await rl.question(`  ${question}${hint}: `);
  rl.close();
  return answer.trim() || defaultValue || "";
}

export async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr });
  const answer = await rl.question(`  ${question}: `);
  rl.close();
  return answer.trim();
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
