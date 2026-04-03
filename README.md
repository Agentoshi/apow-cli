# APoW CLI

Mining client for the [APoW (Agentic Proof of Work)](https://github.com/Agentoshi/apow-core) protocol on Base. Prove you're an AI agent once by minting an ERC-721 Mining Rig, then compete on hash power to mine $AGENT tokens.

**Your agent does all the work. You just fund a wallet.**

`apow setup` is agent-first:
- `Easy Mode`: no config, x402 for RPC + LLM + GPU grinding
- `Advanced Mode`: choose which credentials you supply and which services stay autonomous

`apow start` is the fastest path when you want the full flow in one command:
setup, funding checks, minting, and mining.

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
> 2. **QuickNode x402** (paid, zero setup): Set `USE_X402=true` in your `.env`. Your mining wallet pays $10 USDC for ~1M RPC calls via the [x402 payment protocol](https://www.x402.org/). No API key, no account needed.
>
> Run `apow setup` to configure interactively.

## For AI Agents

Any AI agent can go from zero to actively mining with no human interaction except funding the wallet.
If the wallet is already configured, `apow start` skips ahead automatically.

```bash
npx apow-cli start
```

Easy Mode writes an `.env` equivalent to:

```bash
PRIVATE_KEY=0x...
USE_X402=true
USE_X402_GRIND=true
LLM_PROVIDER=clawrouter
LLM_MODEL=blockrun/eco
ALLOW_LOCAL_FALLBACK_WITH_X402=false
```

**Scale up** with multiple wallets from a single funded wallet:

```bash
# Generate sub-wallets and fund them from your main wallet
npx apow-cli wallet new                    # → sub-wallet address
npx apow-cli wallet fund <sub-address>     # sends mint price + gas from main wallet

# Mint + mine with each sub-wallet
PRIVATE_KEY=<sub-key> npx apow-cli mint
PRIVATE_KEY=<sub-key> npx apow-cli mine &
```

Each wallet gets one rig, each rig mines independently. More wallets = more chances to win each block. See [skill.md](skill.md) for the complete autonomous guide.

## For Humans

If you prefer to do it yourself:

```bash
npx apow-cli start   # guided happy path: setup -> fund -> mint -> mine
```

If you want to control each step manually, the older `setup -> fund -> mint -> mine` flow is still supported below.

## Commands

| Command | Description |
|---------|-------------|
| `apow start` | Guided happy path: setup -> fund -> mint -> mine |
| `apow setup` | Agent-first setup wizard: Easy Mode (x402 everywhere) or Advanced Mode |
| `apow fund` | Fund your wallet: bridge from Solana/Ethereum or send on Base, auto-split ETH+USDC |
| `apow wallet new` | Generate a new mining wallet |
| `apow wallet show` | Show configured wallet address |
| `apow wallet export` | Export your wallet's private key |
| `apow wallet fund <addr> [eth]` | Send ETH to another address (default: mint price + gas) |
| `apow mint` | Mint a MiningAgent NFT (one per wallet) |
| `apow mine [tokenId]` | Mine $AGENT with your NFT (auto-detects best rig) |
| `apow stats [tokenId]` | View mining stats, earnings, difficulty |
| `apow dashboard start` | Launch multi-wallet mining dashboard |
| `apow dashboard add <addr>` | Add a wallet to the dashboard |
| `apow dashboard scan [dir]` | Auto-detect wallet files in a directory |

## Configuration

Create a `.env` file or use `apow setup`:

```bash
PRIVATE_KEY=0x...              # Your wallet private key
USE_X402=true                  # Auto-pay RPC + LLM via x402 (2.00 USDC minimum starting balance, zero API keys)
USE_X402_GRIND=true            # Auto-pay remote GPU grinding via x402
ALLOW_LOCAL_FALLBACK_WITH_X402=false  # Easy Mode default: do not burn local CPU while x402 GPU is active
# RPC_URL=https://...          # Or: bring your own RPC (free from Alchemy, QuickNode, etc.)
# LLM_PROVIDER=clawrouter     # clawrouter (auto with x402) | openai | gemini | deepseek | qwen | anthropic | ollama (for minting)
# LLM_MODEL=blockrun/eco      # Auto-detected per provider; override only if needed
# LLM_API_KEY=sk-...          # Not needed with clawrouter/ollama; required for openai/gemini/etc.
# Bridging (only for `apow fund`)
# SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# ETHEREUM_RPC_URL=https://cloudflare-eth.com
# SQUID_INTEGRATOR_ID=          # free, get at squidrouter.com
# Contract addresses (defaults built-in, override only if needed)
# MINING_AGENT_ADDRESS=0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D
# AGENT_COIN_ADDRESS=0x12577CF0D8a07363224D6909c54C056A183e13b3
```

See [.env.example](.env.example) for all options.

## LLM Providers (for Minting)

An LLM is required to mint your Mining Rig NFT (one-time identity verification). Use a fast, non-thinking model to stay within the 20-second challenge window. Once minted, mining uses optimized algorithmic SMHL solving with no LLM needed.

| Provider | Model | Cost/call | Notes |
|----------|-------|-----------|-------|
| ClawRouter | `blockrun/eco` | ~$0.006 | Recommended. Zero credentials, pays with USDC via x402 |
| OpenAI | `gpt-4o-mini` | ~$0.001 | Cheapest API key option, fast |
| Gemini | `gemini-2.5-flash` | ~$0.001 | Fast, good accuracy |
| DeepSeek | `deepseek-chat` | ~$0.001 | Fast, accessible in China |
| Qwen | `qwen-plus` | ~$0.002 | Alibaba Cloud |
| Anthropic | `claude-sonnet-4-5-20250929` | ~$0.005 | Works but slower |
| Ollama | `llama3.1` | Free | Local GPU required |

## Funding (v0.7.0+)

Mining requires two assets on Base: **ETH** (gas) and **USDC** (x402 RPC). `apow start` checks both and can auto-split the wallet into the right mix. The `fund` command also bridges from Solana or Ethereum, or accepts deposits on Base, and auto-splits into both:

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

- **Algorithmic SMHL**: Mining SMHL challenges are solved algorithmically in microseconds (no LLM call). Your AI was already proven when you minted your Mining Rig.
- **JS threads**: If no native grinders are found, falls back to `worker_threads` across all CPU cores. Set `MINER_THREADS` in `.env` to override.

## Dashboard

Monitor your entire mining fleet from a single web UI. Zero external dependencies -- vanilla HTML/JS served by the CLI.

```bash
# Quick start: scan wallet files and launch
apow dashboard scan .          # detect wallet-0x*.txt files in current directory
apow dashboard start           # open dashboard at http://localhost:3847
```

### Commands

| Command | Description |
|---------|-------------|
| `apow dashboard start` | Launch dashboard web UI (default port 3847) |
| `apow dashboard add <addr>` | Add a wallet address to monitor |
| `apow dashboard remove <addr>` | Remove a wallet from monitoring |
| `apow dashboard scan [dir]` | Auto-detect wallets from `wallet-0x*.txt` files |
| `apow dashboard wallets` | List all monitored wallets |

### Fleet Configuration

Wallets are stored in `~/.apow/wallets.json` (plain JSON array of addresses). For advanced fleet management, create `~/.apow/fleets.json`:

```json
[
  { "name": "Local", "type": "array", "path": "/home/user/.apow/wallets.json" },
  { "name": "Vast.ai", "type": "rigdirs", "path": "/mnt/mining/rigs" },
  { "name": "Pool", "type": "walletfiles", "path": "/mnt/mining/wallets" }
]
```

Fleet types: `array` (JSON array of addresses), `solkek` (master/miners JSON), `rigdirs` (scan `rig*/wallet-0x*.txt`), `walletfiles` (scan `wallet-0x*.txt`).

## Protocol

The APoW protocol contracts and documentation live in [apow-core](https://github.com/Agentoshi/apow-core).

## License

MIT
