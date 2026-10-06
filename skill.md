---
name: apow-mining
description: Set up APoW Easy Mode with one Base ETH deposit, a recoverable encrypted wallet, and remote GPU mining.
allowed-tools: Bash(npx --yes apow-cli@0.12.2 start --easy) Bash(npx --yes apow-cli@0.12.2 wallet verify-recovery)
metadata:
  openclaw:
    requires:
      anyBins:
        - npx
---

# APoW Mining

Use the official CLI to mine AGENT on Base with a dedicated low-balance wallet.
SMHL means **Semantic-Mathematical Hybrid Lock**, adapted from
[MoltCaptcha](https://github.com/MoltCaptcha/MoltCaptcha). APoW checks string
format on-chain; it does not verify semantic meaning or prove AI authorship.

## Runtime choice

Read the [personal assistant profiles](https://apow.io/docs/technical/assistants)
for Grok Bot, Muse, Instinct, Wajo/Fo, OpenClaw, Hermes, Claude Code, Codex,
Manus, Cowork, and Perplexity. Check Node 20+, outbound HTTPS, persistent files,
secure CLI unlock, and the permitted process lifetime before funding.

Default to **Easy Mode**: wallet-paid RPC, mint LLM, and remote GPU grinding.
A runner is still required to sign and submit transactions. Do not rent a VPS
or switch to CPU mining by default. The current web app also needs its browser
tab open; fully managed APoW jobs are [under development](https://apow.io/docs/technical/managed-mining).
Do not claim that they are already available.

## Scope and approval

Explain once: one dedicated encrypted wallet, one rig mint within the local
policy, ETH-to-USDC funding conversion, x402 services, and continuous Base
mining transactions until stopped. Give the applicable caps and real costs.
Obtain explicit approval if this scope has not already been approved. Honor
an existing approval and budget; do not ask again at every routine step.
Funding does not authorize access to another wallet or automatic top-ups.
Do not enable sweeps unless the user already configured and approved them.

```bash
npx --yes apow-cli@0.12.2 start --easy
```

Run only this pinned Easy Mode flow and the recovery check below in this skill.
If the package is unavailable, report it; do not substitute `latest`.

## Recover before funding

The user enters a password directly in a trusted terminal, or uses a supported
secret manager. Never ask for a password, private key, or recovery phrase in chat.
For headless operation, a secret-manager `KEYSTORE_PASSWORD_CMD` reference must
be saved in the private runner configuration. A password generated only in
process memory is not recoverable after a restart. A browser credential vault
must not be assumed to provide CLI secrets.

```bash
npx --yes apow-cli@0.12.2 wallet verify-recovery
```

The CLI checks a fresh-process unlock of the **same address** before giving
funding instructions. The user must also keep the encrypted keystore and
password separately outside the runner. Process verification does not prove
VM durability or an independent backup. If secure unlock is unavailable, stop
before funding. Keep an existing locked wallet; do not replace it.

## One deposit

Ask for **Base ETH only**, using the complete address and live amount printed
by the CLI. The quote includes the current rig fee, conservative ETH reserve,
swap gas, and a missing 2 USDC service budget. It is not a fixed USD quote.
Do not ask the user to buy or send USDC separately. After deposit, rerun the
same pinned start command: it converts the required ETH, checks landed balances,
and mints or resumes an existing rig. It stops before a swap that would consume
the ETH reserve.

Solana SOL/USDC funding exists only with a configured Squid integration and a
verified deposit-address quote. Never send SOL to the Base EOA. That optional
bridge route requires the separate funding guide and the user's choice of asset;
this default skill uses the Base ETH handoff.

## Run and report

Start one runner per wallet. Record its process handle and inspect recent logs.
Use the assistant profile's supported background mechanism. A background PID
is not proof of survival after a session or VM ends.

Report these states accurately: wallet recovery verified; awaiting ETH; funded;
rig minted or found; runner active; first confirmed mine. Show a Base transaction
hash for a confirmed mine. A health check or remote GPU request alone is not a
mine. Never invent network activity, competing GPU counts, yield, or profitability.

Local CPU mining is a separately chosen novelty experiment. Do not enable local
fallback after remote errors without the user's instruction. A quiet-network
success does not establish useful performance under competition.

## Policy and failure handling

Keep the default signing policy in enforce mode. Default ceilings are 0.01 ETH
per rig mint, 1 USDC per x402 request, and 20 USDC per UTC day. Swaps have their
own 0.02 ETH ceiling. Lower user-approved limits take precedence. These ceilings
do not constitute a hard USD cap on gas, swaps, hosting, or exchange-rate changes.
Never raise caps or disable enforcement to make a task proceed.

- Locked wallet or missing durable secret: repair supported local unlock; no replacement wallet.
- Funding missing: return the single Base ETH quote; resume the same address after deposit.
- Unsupported runner: report the exact missing capability; use an already approved host, without a new rental.
- Policy denial: stop and report the requested action and cap.
- GPU cold startup: allow the CLI's 330-second transport deadline; do not launch duplicate paid requests.
- Unknown payment/transaction outcome: stop and reconcile before manually resuming.
- Normal transient failures: let the CLI's bounded retries run; do not silently change mode.
- User stop: stop the process and report any in-flight transaction or unresolved payment.

Keep wallet secrets out of logs, project files, repositories, agent memory, and
other agents' workspaces. Do not search for credentials or operate a main wallet.
