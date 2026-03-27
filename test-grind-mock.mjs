/**
 * Mock GrindProxy server for local testing.
 *
 * Mimics the real GrindProxy API (grind.apow.io):
 *   GET  /health → { ok, service, total_grinds, avg_grind_time }
 *   POST /grind  → spawns local Metal/CPU grinder, returns { nonce, elapsed }
 *
 * No x402 payment gate — @x402/fetch passes through 200 responses transparently.
 *
 * Usage: node test-grind-mock.mjs [port]
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const PORT = parseInt(process.argv[2] || "3999", 10);
const APOW_DIR = join(os.homedir(), ".apow");

let totalGrinds = 0;
let totalTime = 0;

function findGrinder() {
  const gpu = join(APOW_DIR, "grinder-gpu");
  if (existsSync(gpu)) return { path: gpu, label: "Metal GPU" };
  const cpu = join(APOW_DIR, "grinder-cpu");
  if (existsSync(cpu)) return { path: cpu, label: "CPU-C" };
  return null;
}

function grind(challenge, target, address) {
  const grinder = findGrinder();
  if (!grinder) return Promise.reject(new Error("No grinder binary found in ~/.apow/"));

  // Normalize target to 0x-prefixed hex (64 chars)
  let targetHex = target;
  if (!targetHex.startsWith("0x")) {
    targetHex = "0x" + BigInt(targetHex).toString(16).padStart(64, "0");
  }

  const start = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    // Metal/CPU arg order: <challenge> <address> <target>
    // Set cwd to ~/.apow/ so Metal grinder can find keccak.metal shader
    const proc = spawn(grinder.path, [challenge, address, targetHex], { cwd: APOW_DIR });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("close", (code) => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e9;
      if (code === 0) {
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 1) {
          resolve({ nonce: parts[0], elapsed, grinder: grinder.label });
        } else {
          reject(new Error(`Grinder output parse error: ${stdout.trim()}`));
        }
      } else {
        reject(new Error(`Grinder exited ${code}: ${stderr.trim()}`));
      }
    });

    proc.on("error", reject);

    // 90s timeout
    setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch {}
      reject(new Error("Grinder timeout (90s)"));
    }, 90_000);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /health
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "grind-proxy-mock",
      total_grinds: totalGrinds,
      avg_grind_time: totalGrinds > 0 ? totalTime / totalGrinds : 0,
    }));
    return;
  }

  // POST /grind
  if (req.method === "POST" && url.pathname === "/grind") {
    let body = "";
    for await (const chunk of req) body += chunk;

    let params;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const { challenge, target, address } = params;
    if (!challenge || !target || !address) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing challenge, target, or address" }));
      return;
    }

    console.log(`[GRIND] challenge=${challenge.slice(0, 10)}... target=${String(target).slice(0, 10)}... address=${address}`);

    try {
      const result = await grind(challenge, String(target), address);
      totalGrinds++;
      totalTime += result.elapsed;

      console.log(`[GRIND] nonce=${result.nonce} elapsed=${result.elapsed.toFixed(2)}s grinder=${result.grinder}`);

      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Grind-Time": result.elapsed.toFixed(3),
        "X-Grinder": result.grinder,
      });
      res.end(JSON.stringify({ nonce: result.nonce, elapsed: result.elapsed }));
    } catch (err) {
      console.error(`[GRIND] Error: ${err.message}`);
      if (err.message.includes("timeout")) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Grind timeout" }));
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  const grinder = findGrinder();
  console.log(`GrindProxy Mock listening on port ${PORT}`);
  console.log(`  Grinder: ${grinder ? `${grinder.label} (${grinder.path})` : "NONE — install via 'apow build-grinders'"}`);
  console.log(`  Health:  http://localhost:${PORT}/health`);
  console.log(`  Grind:   POST http://localhost:${PORT}/grind`);
  console.log("");
});
