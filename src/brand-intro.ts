import { stdout } from "node:process";

export type BrandSequence = "setup" | "start";

type BrandOutput = Pick<NodeJS.WritableStream, "write"> & {
  columns?: number;
  isTTY?: boolean;
};

export interface BrandIntroOptions {
  output?: BrandOutput;
  color?: boolean;
}

const BASE_BLUE = [0, 82, 255] as const;
const WHITE = [255, 255, 255] as const;

/**
 * Generated from the canonical 512x512 logo.png with:
 * jp2a --colors --color-depth=24 --background=light --size=40x20 --chars='##'
 *
 * The circular edge was normalized after conversion to remove asymmetric
 * transparency sampling at the bottom of the source PNG.
 *
 * # = Base-blue circle
 * @ = white APoW mark
 */
const FULL_LOGO = [
  "############",
  "######################",
  "##########################",
  "##############################",
  "################@@################",
  "################@@@@################",
  "################@@@@@@################",
  "###############@@@##@@@###############",
  "###############@@@####@@@###############",
  "###########@@@@@@@@@@@@@@@@@@###########",
  "#############@@@########@@@#############",
  "#########@@@@@@@@@@@@@@@@@@@@@@#########",
  "##########@@@############@@@##########",
  "#########@@@##############@@@#########",
  "####################################",
  "##################################",
  "##############################",
  "##########################",
  "######################",
  "############",
] as const;

const COMPACT_LOGO = [
  "############",
  "##################",
  "########################",
  "##########################",
  "#############@@#############",
  "#############@@@@#############",
  "#############@@##@@#############",
  "#########@@@@@@@@@@@@@@#########",
  "##########@@@######@@@##########",
  "#######@@@@@@@@@@@@@@@@@@#######",
  "#######@@############@@#######",
  "############################",
  "##########################",
  "########################",
  "##################",
  "############",
] as const;

const MICRO_LOGO = [
  "##########",
  "################",
  "####################",
  "##########@@##########",
  "##########@##@##########",
  "#######@@@@@@@@@@#######",
  "########@@####@@########",
  "######@@@@@@@@@@@@######",
  "######################",
  "####################",
  "################",
  "##########",
] as const;

function startWelcomeLines(columns: number): string[] {
  const startFlow = columns >= 47
    ? [
        "1  Choose Easy or Advanced Mode",
        "2  Fund the displayed Base wallet when prompted",
        "3  Rerun apow start to mint your rig and mine",
      ]
    : [
        "1  Choose Easy or Advanced",
        "2  Fund the Base wallet",
        "3  Rerun apow start to mine",
      ];
  const docsLink = columns >= 27
    ? "Docs: https://apow.io/docs/"
    : "Docs: apow.io/docs";
  const skillLink = columns >= 54
    ? "Skill: https://clawhub.ai/agentoshi/skills/apow-mining"
    : columns >= 46
      ? "Skill: clawhub.ai/agentoshi/skills/apow-mining"
      : "Skill: ClawHub agentoshi/apow-mining";

  return [
    "WELCOME TO THE APoW CLI",
    "Agentic Proof of Work on Base",
    "",
    "START FLOW",
    ...startFlow,
    "",
    docsLink,
    skillLink,
  ];
}

function ansi(
  text: string,
  rgb: readonly [number, number, number],
  enabled: boolean,
): string {
  if (!enabled || !text) return text;
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
}

function renderMaskLine(line: string, color: boolean): string {
  if (!color) return line;
  return (line.match(/#+|@+| +/g) ?? [])
    .map((run) => {
      if (run[0] === "#") return ansi(run, BASE_BLUE, true);
      if (run[0] === "@") return ansi(run, WHITE, true);
      return run;
    })
    .join("");
}

function maskWidth(mask: readonly string[]): number {
  return Math.max(...mask.map((line) => line.length));
}

export function renderBrandLogo(options: { color?: boolean; columns?: number } = {}): string[] {
  const columns = options.columns ?? 48;
  const mask = columns >= 40 ? FULL_LOGO : columns >= 32 ? COMPACT_LOGO : MICRO_LOGO;
  const width = maskWidth(mask);
  const canvasWidth = Math.max(width, columns);

  return mask.map((line) => {
    const leftPadding = " ".repeat(Math.max(0, Math.floor((canvasWidth - line.length) / 2)));
    return leftPadding + renderMaskLine(line, options.color === true);
  });
}

export function renderStartWelcome(options: { color?: boolean; columns?: number } = {}): string[] {
  const columns = options.columns ?? 48;
  const lines = startWelcomeLines(columns);
  const width = Math.max(...lines.map((line) => line.length));
  const leftPadding = " ".repeat(Math.max(0, Math.floor((columns - width) / 2)));

  return lines.map((line, index) => {
    if (!line) return "";
    if (index <= 1) {
      const centered = " ".repeat(Math.max(0, Math.floor((columns - line.length) / 2))) + line;
      return index === 0 ? ansi(centered, BASE_BLUE, options.color === true) : centered;
    }
    return leftPadding + line;
  });
}

export async function showBrandIntro(
  sequence: BrandSequence,
  options: BrandIntroOptions = {},
): Promise<void> {
  const output = options.output ?? stdout;
  const color = options.color
    ?? (output.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb");
  const lines = renderBrandLogo({ color, columns: output.columns });
  const sections = [lines.join("\n")];
  if (sequence === "start") {
    sections.push(renderStartWelcome({ color, columns: output.columns }).join("\n"));
  }
  output.write(`\n${sections.join("\n\n")}\n\n`);
}
