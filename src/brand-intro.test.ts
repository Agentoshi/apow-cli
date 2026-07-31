import assert from "node:assert/strict";
import test from "node:test";

import { renderBrandLogo, renderStartWelcome, showBrandIntro } from "./brand-intro";

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

test("start intro renders the real APoW logo and a concise welcome guide", async () => {
  let rendered = "";
  const output = {
    isTTY: false,
    columns: 80,
    write(chunk: string | Uint8Array) {
      rendered += String(chunk);
      return true;
    },
  };

  await showBrandIntro("start", { output });

  assert.equal(renderBrandLogo({ columns: 80 }).length, 20);
  assert.match(rendered, /@@@##@@@/);
  assert.match(rendered, /@@@@@@@@@@@@@@@@@@@/);
  assert.match(rendered, /WELCOME TO THE APoW CLI/);
  assert.match(rendered, /2  Fund the displayed Base wallet when prompted/);
  assert.match(rendered, /3  Rerun apow start to mint your rig and mine/);
  assert.match(rendered, /Docs: https:\/\/apow\.io\/docs\//);
  assert.match(rendered, /Skill: https:\/\/clawhub\.ai\/agentoshi\/skills\/apow-mining/);
  assert.equal(rendered.includes("The Skill"), false);
  assert.equal(rendered.includes("Agent guide"), false);
  assert.equal(rendered.includes("SIGNAL"), false);
  assert.equal(rendered.includes("PROTOCOL"), false);
  assert.equal(rendered.includes("SEQUENCE"), false);
  assert.equal(rendered.includes("\x1b["), false);
});

test("TTY rendering uses only canonical Base blue and white without animation controls", async () => {
  let rendered = "";
  const output = {
    isTTY: true,
    columns: 80,
    write(chunk: string | Uint8Array) {
      rendered += String(chunk);
      return true;
    },
  };

  await showBrandIntro("setup", { output, color: true });

  assert.match(rendered, /\x1b\[38;2;0;82;255m/);
  assert.match(rendered, /\x1b\[38;2;255;255;255m/);
  assert.equal(rendered.includes("\x1b[2K"), false);
  assert.equal(rendered.includes("\x1b[20F"), false);

  const plainRendered = `\n${renderBrandLogo({ columns: 80 }).join("\n")}\n\n`;
  assert.equal(stripAnsi(rendered), plainRendered);
});

test("narrow terminals use a generated compact logo", () => {
  const compact = renderBrandLogo({ columns: 32 });
  const micro = renderBrandLogo({ columns: 24 });
  const narrowWelcome = renderStartWelcome({ columns: 40 });
  const narrowText = narrowWelcome.map((line) => line.trimStart());

  assert.equal(compact.length, 16);
  assert.equal(micro.length, 12);
  assert.equal(Math.max(...compact.map((line) => line.length)) <= 32, true);
  assert.equal(Math.max(...micro.map((line) => line.length)) <= 24, true);
  assert.equal(Math.max(...narrowWelcome.map((line) => line.length)) <= 40, true);
  assert.equal(narrowText.includes("1  Choose Easy or Advanced"), true);
  assert.equal(narrowText.includes("2  Fund the Base wallet"), true);
  assert.equal(narrowText.includes("3  Rerun apow start to mine"), true);
  assert.equal(narrowText.includes("Skill: ClawHub agentoshi/apow-mining"), true);
  assert.equal(compact.some((line) => line.includes("@@@@@@")), true);
  assert.equal(micro.some((line) => line.includes("@@@@@@")), true);
});

test("welcome instructions appear for start but not setup", async () => {
  let setupOutput = "";
  await showBrandIntro("setup", {
    color: false,
    output: {
      isTTY: false,
      columns: 80,
      write(chunk: string | Uint8Array) {
        setupOutput += String(chunk);
        return true;
      },
    },
  });

  assert.equal(setupOutput.includes("WELCOME TO THE APoW CLI"), false);
  assert.equal(renderStartWelcome({ columns: 80 }).some((line) => line.includes("https://clawhub.ai/agentoshi/skills/apow-mining")), true);
});
