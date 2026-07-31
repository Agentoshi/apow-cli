# APoW CLI

Agent-first mining client for [APoW (Agentic Proof of Work)](https://apow.io) on
Base. Onboard a Mining Rig, then run the protocol's SMHL and Keccak verification
flow continuously to earn $AGENT tokens. The contracts are
[open source](https://github.com/Agentoshi/apow-core).

**Your agent does all the work. You just fund a wallet.**

`apow setup` is agent-first:
- `Easy Mode`: no config, x402 for RPC + LLM + GPU grinding
- `Advanced Mode`: choose which credentials you supply and which services stay autonomous

`apow start` is the fastest path: choose Easy or Advanced Mode, complete the
mandatory Base funding handoff, mint, and mine continuously. Agents can select
the same existing Easy Mode directly with `apow start --easy`.

## Install

```bash
npm install -g apow-cli
```

Or run directly:

```bash
npx apow-cli
```

## RPC Setup

> **v0.8.0+: Bring your own RPC or use auto-pay.** You need a Base RPC endpoint. Two options:
>
> 1. **Bring your own** (free): Get a free RPC URL from [Alchemy](https://www.alchemy.com/), [QuickNode](https://www.quicknode.com/), or any Base RPC provider. Set `RPC_URL` in your `.env`.
> 2. **QuickNode x402** (paid, zero setup): Set `USE_X402=true` in your `.env`. Your mining wallet pays for RPC usage via the [x402 payment protocol](https://www.x402.org/). Start with at least 2.00 USDC on Base and add more for headroom. No API key or account needed.
>
> Run `apow setup` to configure interactively.

## For AI Agents

Mining cannot begin until the dedicated wallet has ETH and USDC on Base. The
same command handles both phases: it first creates/configures the wallet and
prints its funding address, then automatically mints and mines when rerun after
the user funds that address and confirms funding.

```bash
npx --yes apow-cli@0.12.0 start --easy
```

Relevant Easy Mode settings include:

```bash
KEYSTORE_PATH=~/.apow/keystores/wallet-0x....json
USE_X402=true
USE_X402_GRIND=true
LLM_PROVIDER=clawrouter
ALLOW_LOCAL_FALLBACK_WITH_X402=false
```

The keystore password is prompted interactively. For headless launch services,
provide `KEYSTORE_PASSWORD` from your shell, process manager, or secret store.
Never put it in chat or commit it to a project file. See [skill.md](skill.md) for
the narrow autonomous mining workflow.

## For Humans

If you prefer to do it yourself:

```bash
npx apow-cli start   # guided happy path: setup -> funding checks -> mint -> mine
```

If you want to control each step manually, the older step-by-step flow is still supported below.

## Commands

| Command | Description |
|---------|-------------|
| `apow start [--easy]` | Existing Easy/Advanced flow: setup -> Base funding check/handoff -> mint -> mine |
| `apow setup` | Agent-first setup wizard: Easy Mode (x402 everywhere) or Advanced Mode |
| `apow fund` | Interactive bridge/deposit route and ETH+USDC auto-split |
| `apow wallet new` | Generate a new encrypted mining wallet |
| `apow wallet list` | List every wallet generated locally by this APoW CLI and mark the active wallet |
| `apow wallet use [address-or-number]` | Select a generated wallet for the current project (`select` is an alias) |
| `apow wallet show` | Show configured wallet address |
| `apow wallet backup` | Show the encrypted keystore backup location; never display wallet secrets |
| `apow wallet migrate` | Encrypt legacy `PRIVATE_KEY` into a keystore and clear `.env` |
| `apow wallet payout set <addr>` | Configure a cold payout address for AGENT sweeps |
| `apow wallet sweep [--all]` | Sweep mined AGENT, and optionally excess ETH/USDC, to payout |
| `apow wallet fund <addr> [eth]` | Send ETH to another address (default: mint price + gas) |
| `apow policy show/init/set mode` | Inspect or change local signing policy |
| `apow mint` | Confirm and mint a MiningAgent NFT (one per wallet) |
| `apow mine [tokenId]` | Mine $AGENT continuously (auto-detects best rig) |
| `apow stats [tokenId]` | View mining stats |
| `apow dashboard start` | Launch the local APoW-wallet dashboard |
| `apow dashboard wallets` | List wallets generated locally by this CLI |

## Configuration

Create a `.env` file or use `apow setup`:

```bash
KEYSTORE_PATH=~/.apow/keystores/wallet-0x....json  # Preferred: encrypted wallet JSON
USE_X402=true                  # Auto-pay RPC + LLM via x402 (2.00 USDC minimum starting balance, no API keys)
USE_X402_GRIND=true            # Auto-pay remote GPU grinding via x402
ALLOW_LOCAL_FALLBACK_WITH_X402=false  # Easy Mode default: do not burn local CPU while x402 GPU is active
# STALE_CHECK_INTERVAL=5       # Seconds between stale-challenge checks while grinding (default: 5)
# RPC_URL=https://...          # Or: bring your own RPC (free from Alchemy, QuickNode, etc.)
# LLM_PROVIDER=clawrouter     # x402: clawrouter | API key: openai/anthropic/gemini/deepseek/qwen | local/subscription CLI: ollama/claude-code/codex
# LLM_MODEL=...              # Optional override; x402 selects automatically
# LLM_API_KEY=sk-...          # Required only for API-key providers
# KEYSTORE_PASSWORD=...       # Headless unlock only; prefer shell/process secret storage over committing to .env
# KEYSTORE_PASSWORD_CMD=...   # Preferred headless unlock command, stdout is used as password
# APOW_POLICY=enforce         # enforce | warn | off
# APOW_PAYOUT_ADDRESS=0x...   # optional cold payout wallet for AGENT sweeps
# Bridging (only for `apow fund`)
# SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# ETHEREUM_RPC_URL=https://cloudflare-eth.com
# SQUID_INTEGRATOR_ID=          # free, get at squidrouter.com
# Contract addresses (defaults built-in, override only if needed)
# MINING_AGENT_ADDRESS=0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D
# AGENT_COIN_ADDRESS=0x12577CF0D8a07363224D6909c54C056A183e13b3
```

See [.env.example](.env.example) for all options.

## Wallet Protocol v2

Mining requires a hot EOA because the immutable APoW contracts require direct wallet signatures. Wallet Protocol v2 limits that hot wallet's blast radius:

- every transaction and x402 typed-data signature goes through a local policy guard;
- mined AGENT can be swept to a separate payout address with `apow wallet payout set <addr>` — AGENT transfers are frozen on-chain until the LP pool deploys, so the CLI skips AGENT sweeps until `lpDeployed` flips and then activates them automatically (ETH/USDC sweeps via `--all` work immediately);
- audit and spend ledgers are written under `~/.apow/audit-<address>.jsonl` and `~/.apow/spend-<address>.jsonl`;
- child grinder and local LLM processes do not receive wallet or keystore-password secrets;
- generated wallets are written only as encrypted keystores, and wallet commands never print or write a raw-key export;
- Easy Mode refuses to run if the enforce-mode mint or x402 policy caps were relaxed beyond its defaults;
- `apow start --easy` selects the existing Easy Mode without adding a second approval or wallet-control system.

Useful commands:

```bash
apow policy show
apow wallet payout set 0x...
apow wallet sweep
apow wallet migrate            # convert legacy PRIVATE_KEY to KEYSTORE_PATH
```

For headless unlocks, prefer a command that prints the password from your OS secret store:

```bash
KEYSTORE_PASSWORD_CMD="security find-generic-password -s apow-keystore -w"
```

## LLM Providers (for Minting)

An LLM is required when minting a new Mining Rig NFT because the mint gate uses a
20-second SMHL challenge. Easy Mode handles SMHL and mining automatically after
the user funds the dedicated wallet.

Advanced Step 3 groups the choices by payment and execution model:

1. **Auto** — Zero Config via x402. The model is selected automatically and each
   request is paid from the mining wallet's Base USDC balance.
2. **API key** — OpenAI, Anthropic, Gemini, DeepSeek, or Qwen.
3. **Local / subscription CLI** — Ollama runs inference on the user's machine;
   Claude Code and Codex run local command-line clients but use hosted models and
   the user's existing subscription allowance.

| Provider | Default model | Billing | Notes |
|----------|---------------|---------|-------|
| Auto via x402 | Automatic | Wallet-paid USDC | Zero Config; no API key or model selection required |
| OpenAI | `gpt-4o-mini` | ~$0.001 | Cheapest API key option, fast |
| Gemini | `gemini-2.5-flash` | ~$0.001 | Fast, good accuracy |
| DeepSeek | `deepseek-chat` | ~$0.001 | Fast, accessible in China |
| Qwen | `qwen-plus` | ~$0.002 | Alibaba Cloud |
| Anthropic | `claude-sonnet-4-5-20250929` | ~$0.005 | Works but slower |
| Ollama | `llama3.1` | Local compute | Truly local inference; Ollama must be running with the model installed |
| Claude Code | `haiku` | Claude subscription allowance | Hosted inference through an installed, signed-in CLI |
| Codex | `gpt-5.6-luna` | ChatGPT subscription allowance | Hosted inference through an installed, signed-in CLI |

Prepare one of the local/subscription choices before minting:

```bash
ollama pull llama3.1   # Ollama only; keep the Ollama service running
claude login           # Claude Code; sign in with the intended Claude subscription
codex login            # Codex; choose ChatGPT subscription access
```

APoW disables Claude Code tools and session persistence. It runs Codex from an
isolated temporary directory in ephemeral, read-only mode. Both child processes
receive a strict environment allowlist rather than wallet secrets or API-billing
keys. Both subscription adapters passed off-chain SMHL command tests; neither is
yet recorded as a completed APoW mainnet mint.

## Funding (v0.7.0+)

Mining requires two assets on Base: **ETH** (gas) and **USDC** (x402 RPC).
`apow start` checks both and gives a Base funding handoff without moving funds.
The separate `fund` command provides an interactive bridge or auto-split flow:

```bash
# From Solana (deposit address — send from any wallet, QR code included)
apow fund --chain solana --token sol              # bridge SOL → ETH, auto-swap portion to USDC
apow fund --chain solana --token usdc             # bridge USDC, auto-swap portion to ETH

# From Ethereum mainnet
apow fund --chain ethereum                        # bridge ETH → ETH on Base, auto-swap portion to USDC

# Already on Base
apow fund --chain base --token eth                # show address, wait for deposit, auto-split
apow fund --chain base --token usdc               # show address, wait for deposit, auto-split

# Skip auto-split (keep single asset)
apow fund --chain base --no-swap
```

**Solana/Ethereum bridging:** Uses [Squid Router](https://squidrouter.com/) (Chainflip). Generates a one-time deposit address with QR code — send from any wallet. Requires `SQUID_INTEGRATOR_ID` in `.env` (free at [squidrouter.com](https://app.squidrouter.com/)).

**Auto-split targets:** 0.003 ETH (gas for ~100 mine txns) + 2.00 USDC (minimum x402 starting balance). If both are already met, the CLI skips the swap.

## x402 GPU Grinding

No GPU? No problem. Remote RTX 4090 nonce grinding via the [x402 payment protocol](https://www.x402.org/) — ~$0.006/grind (dynamic pricing tracks actual GPU cost), zero setup:

```bash
# In your .env (enabled automatically in Easy Mode)
USE_X402_GRIND=true
# ALLOW_LOCAL_FALLBACK_WITH_X402=true   # Advanced Mode hybrid option
```

In Easy Mode, the HTTP grinder is the only nonce source, so agents do not silently burn local CPU while remote x402 GPU mining is active. Advanced Mode can opt into a hybrid local fallback. Front-running is cryptographically impossible — nonces are bound to `keccak256(challenge, msg.sender, nonce)`.

| Config | Description |
|--------|-------------|
| `USE_X402_GRIND` | Enable remote GPU grinding (default: same as `USE_X402`) |
| `ALLOW_LOCAL_FALLBACK_WITH_X402` | Let local JS fallback run alongside x402 GPU (`false` in Easy Mode) |
| `GRIND_URL` | Custom GrindProxy endpoint (default: `https://grind.apow.io/grind`) |

Self-host your own GrindProxy: see [apow-grind](https://github.com/Agentoshi/apow-grind).

## GPU Mining (v0.9.2+)

The miner auto-detects native GPU and CPU grinder binaries for dramatically faster nonce grinding. Source files ship with the npm package — run `apow build-grinders` to compile and install to `~/.apow/`:

```bash
npx apow-cli build-grinders              # auto-detects compilers + GPU arch
npx apow-cli build-grinders --cuda-arch sm_89  # override CUDA architecture
```

| Grinder | Platform | Speed | Requirements |
|---------|----------|-------|--------------|
| Metal GPU | macOS (Apple Silicon) | ~260-500 MH/s | Xcode CLI tools (`clang`) |
| CUDA | NVIDIA GPU | ~20 GH/s | CUDA toolkit (`nvcc`) |
| CPU-C | Any (multi-threaded C) | ~150-300 MH/s | `clang` or `gcc` |
| JS (fallback) | Any (worker_threads) | ~2-5 MH/s | Built-in, no setup |

All available grinders race in parallel — first valid nonce wins. Falls back to JS automatically if no native binaries are found.

### Remote GPU Setup (Vast.ai)

```bash
./local/vast-setup.sh    # rent RTX 4090, upload + compile CUDA grinder
```

Then add to `.env`:
```
VAST_IP=<ip>
VAST_PORT=<port>
```

The CUDA grinder runs over SSH alongside your local Metal/CPU grinders — genuinely additive hash power.

### Other Optimizations

- **Faster stale restarts**: The miner re-checks the challenge every 5 seconds by default and aborts dead work quickly across local, native GPU/CPU, and x402 grinding.
- **JS threads**: If no native grinders are found, falls back to `worker_threads` across all CPU cores. Set `MINER_THREADS` in `.env` to override.

## Dashboard

Monitor wallets generated locally by this APoW CLI from a single web UI. Zero external dependencies -- vanilla HTML/JS served by the CLI on `127.0.0.1` only. The dashboard does not scan directories, ingest wallet files, accept manually added addresses, or load external fleet configurations. It loads once, then only refreshes chain data when you click **Refresh**, so it does not burn RPC quota in the background.

```bash
# Quick start: generate an encrypted wallet and launch
apow wallet new
apow dashboard start           # open http://localhost:3847
```

### Commands

| Command | Description |
|---------|-------------|
| `apow dashboard start` | Launch dashboard web UI |
| `apow dashboard wallets` | List wallets generated locally by this CLI |

### Wallet Scope

`~/.apow/generated-wallets.json` records only addresses and encrypted-keystore paths created by `apow wallet new` or the setup wizard's new-wallet flow. A wallet appears only while its matching keystore exists under `~/.apow/keystores/`. Imported wallets, arbitrary addresses, legacy plaintext files, and unrelated filesystem artifacts are intentionally excluded.

Refreshes use chunked multicalls and a 25-second cache. Clicking **Refresh** after the cache expires waits for a fresh RPC read; clicking again inside the cache window reuses the current data.

## Protocol

The APoW protocol contracts and documentation live in [apow-core](https://github.com/Agentoshi/apow-core).

## License

MIT
