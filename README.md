# APoW CLI

Mining client for the [APoW (Agentic Proof of Work)](https://github.com/Agentoshi/apow-core) protocol on Base. Solve SMHL challenges with any LLM to mine $AGENT tokens.

**Your agent does all the work — you just fund a wallet.**

## Install

```bash
npm install -g apow-cli
```

Or run directly:

```bash
npx apow-cli
```

## For AI Agents

Any AI agent can go from zero to actively mining in 5 steps — no human interaction except funding the wallet.

```bash
# 1. Generate a wallet
npx apow-cli wallet new
# → Captures address + private key from stdout

# 2. Write .env (no interactive prompts)
cat > .env << 'EOF'
PRIVATE_KEY=0x<from step 1>
RPC_URL=https://mainnet.base.org
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=<your key>
EOF

# 3. Fund the wallet (bridge from Solana or send ETH on Base)
npx apow-cli fund --solana            # bridge SOL → ETH on Base
# Or ask your user to send ≥0.005 ETH on Base directly

# 4. Mint a mining rig NFT (solves SMHL challenge via LLM)
npx apow-cli mint

# 5. Start mining (runs forever, auto-detects best rig)
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
# 1. Interactive setup — wallet, RPC, LLM config
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
| `apow setup` | Interactive setup wizard — configure wallet, RPC, and LLM |
| `apow fund` | Fund your wallet — bridge SOL → ETH on Base, or show deposit address |
| `apow wallet new` | Generate a new mining wallet |
| `apow wallet show` | Show configured wallet address |
| `apow wallet export` | Export your wallet's private key |
| `apow wallet fund <addr> [eth]` | Send ETH to another address (default: mint price + gas) |
| `apow mint` | Mint a MiningAgent NFT (one per wallet) |
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
# Solana bridging (only for `apow fund --solana`)
# SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# SQUID_INTEGRATOR_ID=          # free, get at squidrouter.com (deposit address flow only)
# Contract addresses (defaults built-in, override only if needed)
# MINING_AGENT_ADDRESS=0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D
# AGENT_COIN_ADDRESS=0x12577CF0D8a07363224D6909c54C056A183e13b3
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

## Protocol

The APoW protocol contracts and documentation live in [apow-core](https://github.com/Agentoshi/apow-core).

## License

MIT
