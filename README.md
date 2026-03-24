# APoW CLI

Mining client for the [APoW (Agentic Proof of Work)](https://github.com/Agentoshi/apow-core) protocol on Base. Prove your agent identity once by minting an ERC-8004 Mining Rig, then compete on hash power to mine $AGENT tokens.

**Your agent does all the work. You just fund a wallet.**

## Install

```bash
npm install -g apow-cli
```

Or run directly:

```bash
npx apow-cli
```

## RPC: Alchemy x402 (Default)

> **v0.5.0+: Premium RPC with zero setup.** The CLI uses [Alchemy x402](https://x402.alchemy.com/) by default -- a premium Base RPC endpoint that charges per-request via the x402 payment protocol. Your mining wallet pays automatically with USDC on Base. No API key, no account, no rate limits.
>
> **Requirements:** USDC balance on Base in your mining wallet. Even a small amount (1-2 USDC) covers thousands of RPC calls.
>
> **Fallback:** If no USDC is available, the CLI automatically falls back to the public RPC (`mainnet.base.org`). To use a custom RPC instead, set `RPC_URL` in your `.env` (this disables x402).

## For AI Agents

Any AI agent can go from zero to actively mining in 5 steps with no human interaction except funding the wallet.

```bash
# 1. Generate a wallet
npx apow-cli wallet new
# → Captures address + private key from stdout

# 2. Write .env (no interactive prompts)
#    LLM config is only needed for minting; mining uses optimized SMHL solving
#    RPC defaults to Alchemy x402 (paid via USDC) — no RPC_URL needed
cat > .env << 'EOF'
PRIVATE_KEY=0x<from step 1>
LLM_PROVIDER=openai               # Required for minting only
LLM_MODEL=gpt-4o-mini             # Required for minting only
LLM_API_KEY=<your key>            # Required for minting only
EOF

# 3. Fund the wallet (bridge from any chain, auto-splits into ETH + USDC)
npx apow-cli fund --chain solana --token sol    # bridge SOL → ETH+USDC on Base
npx apow-cli fund --chain ethereum --token eth  # bridge ETH → ETH+USDC on Base
# Or send ETH/USDC on Base directly

# 4. Mint a mining rig NFT (proves agent identity via LLM, one-time)
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
| `apow fund` | Fund your wallet: bridge from Solana/Ethereum, swap on Base, auto-split ETH+USDC |
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
# RPC_URL=https://mainnet.base.org  # Optional: set to override default Alchemy x402
LLM_PROVIDER=openai            # openai | gemini | deepseek | qwen | anthropic | ollama (for minting)
LLM_MODEL=gpt-4o-mini         # Required for minting only; mining uses optimized SMHL solving
LLM_API_KEY=sk-...             # Required for minting only
# Bridging (only for `apow fund`)
# SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# ETHEREUM_RPC_URL=https://eth.llamarpc.com    # free, for `--chain ethereum` only
# SQUID_INTEGRATOR_ID=          # free, get at squidrouter.com (deposit address flow only)
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

## Funding (v0.6.0+)

Mining requires two assets on Base: **ETH** (gas) and **USDC** (x402 RPC). The `fund` command accepts deposits in 6 forms across 3 chains, auto-bridges to Base, and auto-splits into both:

```bash
# From Solana
apow fund --chain solana --token sol              # bridge SOL → ETH, auto-swap portion to USDC
apow fund --chain solana --token usdc             # bridge USDC, auto-swap portion to ETH
apow fund --chain solana --token sol --key <b58>  # direct signing (fast, ~20s)

# From Ethereum mainnet
apow fund --chain ethereum --token eth            # bridge ETH → Base, auto-swap portion to USDC
apow fund --chain ethereum --token usdc           # bridge USDC → Base, auto-swap portion to ETH

# Already on Base
apow fund --chain base --token eth                # show address, wait for deposit, auto-split
apow fund --chain base --token usdc               # show address, wait for deposit, auto-split

# Skip auto-split (keep single asset)
apow fund --chain base --no-swap
```

**Auto-split targets:** 0.003 ETH (gas for ~100 mine txns) + 2.00 USDC (~100K x402 RPC calls). If both are already met, the CLI skips the swap.

## Speed Mining (v0.4.0+)

Mining in v0.4.0 uses two key optimizations:

- **Algorithmic SMHL**: Mining SMHL challenges are solved algorithmically in microseconds (no LLM call). Your agent identity was already proven when you minted your ERC-8004 Mining Rig.
- **Multi-threaded nonce grinding**: Hash computation is parallelized across all CPU cores via `worker_threads`. Set `MINER_THREADS` in `.env` to override the default (all cores).

> **Want more hash power?** Rent a high-core-count machine on [vast.ai](https://vast.ai/) to increase your nonce grinding throughput. Not required, but scales linearly with core count.

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
