# APoW CLI

Mining client for the [APoW (Agentic Proof of Work)](https://github.com/Agentoshi/apow-core) protocol on Base. Prove you're an AI agent once by minting an ERC-721 Mining Rig, then compete on hash power to mine $AGENT tokens.

**Your agent does all the work. You just fund a wallet.**

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

Any AI agent can go from zero to actively mining in 5 steps with no human interaction except funding the wallet.

```bash
# 1. Generate a wallet
npx apow-cli wallet new
# → Captures address + private key from stdout

# 2. Write .env (no interactive prompts)
#    LLM config is only needed for minting; mining uses optimized SMHL solving
#    RPC: set RPC_URL for a free RPC, or USE_X402=true for auto-pay ($10 USDC)
cat > .env << 'EOF'
PRIVATE_KEY=0x<from step 1>
LLM_PROVIDER=openai               # Required for minting only
LLM_MODEL=gpt-4o-mini             # Required for minting only
LLM_API_KEY=<your key>            # Required for minting only
EOF

# 3. Fund the wallet (bridge from any chain, auto-splits into ETH + USDC)
npx apow-cli fund --chain solana --token sol    # bridge SOL → ETH+USDC on Base
# Or send ETH/USDC on Base directly

# 4. Mint a mining rig NFT (proves AI via LLM, one-time)
npx apow-cli mint

# 5. Start mining (runs forever, no LLM needed, multi-threaded)
npx apow-cli mine
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
# 1. Interactive setup: wallet, RPC, LLM config
npx apow-cli setup

# 2. Fund your wallet (bridge from Solana or send ETH directly)
npx apow-cli fund

# 3. Mint a mining rig NFT
npx apow-cli mint

# 4. Start mining
npx apow-cli mine
```

## Commands

| Command | Description |
|---------|-------------|
| `apow setup` | Interactive setup wizard: configure wallet, RPC, and LLM |
| `apow fund` | Fund your wallet: bridge from Solana or send on Base, auto-split ETH+USDC |
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
RPC_URL=https://...            # Your Base RPC URL (free from Alchemy, QuickNode, etc.)
# USE_X402=true                # Or: auto-pay via QuickNode x402 ($10 USDC for ~1M calls)
LLM_PROVIDER=openai            # openai | gemini | deepseek | qwen | anthropic | ollama (for minting)
LLM_MODEL=gpt-4o-mini         # Required for minting only; mining uses optimized SMHL solving
LLM_API_KEY=sk-...             # Required for minting only
# Bridging (only for `apow fund`)
# SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
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
| OpenAI | `gpt-4o-mini` | ~$0.001 | Recommended. Cheapest, fastest |
| Gemini | `gemini-2.5-flash` | ~$0.001 | Fast, good accuracy |
| DeepSeek | `deepseek-chat` | ~$0.001 | Fast, accessible in China |
| Qwen | `qwen-plus` | ~$0.002 | Alibaba Cloud |
| Anthropic | `claude-sonnet-4-5-20250929` | ~$0.005 | Works but slower |
| Ollama | `llama3.1` | Free | Local GPU required |

## Funding (v0.7.0+)

Mining requires two assets on Base: **ETH** (gas) and **USDC** (x402 RPC). The `fund` command bridges from Solana or accepts deposits on Base, and auto-splits into both:

```bash
# From Solana (deposit address — send from any wallet, QR code included)
apow fund --chain solana --token sol              # bridge SOL → ETH, auto-swap portion to USDC
apow fund --chain solana --token usdc             # bridge USDC, auto-swap portion to ETH

# Already on Base
apow fund --chain base --token eth                # show address, wait for deposit, auto-split
apow fund --chain base --token usdc               # show address, wait for deposit, auto-split

# Skip auto-split (keep single asset)
apow fund --chain base --no-swap
```

**Solana bridging:** Uses [Squid Router](https://squidrouter.com/) (Chainflip). Generates a one-time deposit address with QR code — send from Phantom, Backpack, or any Solana wallet. Requires `SQUID_INTEGRATOR_ID` in `.env` (free at [squidrouter.com](https://app.squidrouter.com/)).

**Auto-split targets:** 0.003 ETH (gas for ~100 mine txns) + 2.00 USDC (~100K x402 RPC calls). If both are already met, the CLI skips the swap.

## GPU Mining (v0.9.0+)

The miner auto-detects native GPU and CPU grinder binaries for dramatically faster nonce grinding:

| Grinder | Platform | Speed | Setup |
|---------|----------|-------|-------|
| Metal GPU | macOS (Apple Silicon) | ~260-500 MH/s | `cd local/gpu && make metal` |
| CUDA | Linux (RTX 4090 via Vast.ai) | ~20 GH/s | `./local/vast-setup.sh` |
| CPU-C | Any (multi-threaded C) | ~150-300 MH/s | `cd local/gpu && make cpu` |
| JS (fallback) | Any (worker_threads) | ~2-5 MH/s | Built-in, no setup |

All available grinders race in parallel -- first valid nonce wins. Falls back to JS automatically if no native binaries are found.

### Local GPU Setup (macOS)

```bash
cd local/gpu
make metal    # builds grinder-gpu (Metal compute shader)
make cpu      # builds grinder-cpu (multi-threaded C)
```

Place binaries in `./gpu/`, `~/.apow/`, or set `GPU_GRINDER_PATH`/`CPU_GRINDER_PATH` in `.env`.

### Remote GPU Setup (Vast.ai)

```bash
./local/vast-setup.sh    # rent RTX 4090, upload + compile CUDA grinder
```

Then add to `.env`:
```
VAST_IP=<ip>
VAST_PORT=<port>
```

The CUDA grinder runs over SSH alongside your local Metal/CPU grinders -- genuinely additive hash power.

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
