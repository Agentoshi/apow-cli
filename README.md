# APoW CLI

Mining client for the [APoW (Agentic Proof of Work)](https://github.com/Agentoshi/apow-core) protocol on Base. Solve SMHL challenges with any LLM to mine $AGENT tokens.

## Install

```bash
npm install -g apow
```

Or run directly:

```bash
npx apow
```

## Quick Start

```bash
# 1. Interactive setup — wallet, RPC, LLM config
npx apow setup

# 2. Fund your wallet with ETH on Base (≥0.005 ETH)

# 3. Mint a mining rig NFT
npx apow mint

# 4. Start mining
npx apow mine
```

## Commands

| Command | Description |
|---------|-------------|
| `apow setup` | Interactive setup wizard — configure wallet, RPC, and LLM |
| `apow wallet new` | Generate a new mining wallet |
| `apow wallet export` | Export your wallet's private key |
| `apow mint` | Mint a MiningAgent NFT (solves SMHL challenge) |
| `apow mine [tokenId]` | Mine $AGENT with your NFT (auto-detects best rig) |
| `apow stats [tokenId]` | View mining stats, earnings, difficulty |

## Configuration

Create a `.env` file or use `apow setup`:

```bash
PRIVATE_KEY=0x...              # Your wallet private key
RPC_URL=https://mainnet.base.org
LLM_PROVIDER=openai            # openai | anthropic | gemini | ollama | claude-code | codex
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...
MINING_AGENT_ADDRESS=0x...     # Deployed contract address
AGENT_COIN_ADDRESS=0x...       # Deployed contract address
```

See [.env.example](.env.example) for all options.

## LLM Providers

| Provider | Model | Cost/call | Notes |
|----------|-------|-----------|-------|
| OpenAI | `gpt-4o-mini` | ~$0.001 | Cheapest cloud option |
| Anthropic | `claude-sonnet-4-5-20250929` | ~$0.005 | High accuracy |
| Gemini | `gemini-2.5-flash` | ~$0.001 | Fast |
| Ollama | `llama3.1` | Free | Local GPU required |
| Claude Code | `default` | Subscription | No API key needed |
| Codex | `default` | Subscription | No API key needed |

## For AI Agents

See [skill.md](skill.md) for a complete self-contained guide to go from zero to actively mining. Any AI agent can follow it autonomously.

## Protocol

The APoW protocol contracts and documentation live in [apow-core](https://github.com/Agentoshi/apow-core).

## License

MIT
