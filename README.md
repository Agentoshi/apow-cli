# APoW CLI

Mining client for the [APoW (Agentic Proof of Work)](https://github.com/Agentoshi/apow-core) protocol on Base. Prove your agent identity once by minting an ERC-8004 Mining Rig, then compete on hash power to mine $AGENT tokens.

**Your agent does all the work — you just fund a wallet.**

## Install

```bash
npm install -g apow-cli
```

Or run directly:

```bash
npx apow-cli
```

## Important: RPC Endpoint

> **The default public RPC (`mainnet.base.org`) is unreliable for mining.** It rate-limits aggressively and will cause frequent transaction failures. **We strongly recommend getting a free Alchemy endpoint** before you start:
>
> 1. Sign up at [alchemy.com](https://www.alchemy.com/) (free, no credit card)
> 2. Create an app → Chain: **Base** → Network: **Base Mainnet**
> 3. Copy the HTTPS URL → set `RPC_URL` in your `.env`
>
> Alchemy's free tier gives you 300M compute units/month — more than enough for mining. See [RPC Recommendations](skill.md#rpc-recommendations) for other free options.

## For AI Agents

Any AI agent can go from zero to actively mining in 5 steps — no human interaction except funding the wallet.

```bash
# 1. Generate a wallet
npx apow-cli wallet new
# → Captures address + private key from stdout

# 2. Write .env (no interactive prompts)
#    LLM config is only needed for minting — mining uses optimized SMHL solving
cat > .env << 'EOF'
PRIVATE_KEY=0x<from step 1>
RPC_URL=https://mainnet.base.org  # UNRELIABLE — get a free Alchemy URL (see above)
LLM_PROVIDER=openai               # Required for minting only
LLM_MODEL=gpt-4o-mini             # Required for minting only
LLM_API_KEY=<your key>            # Required for minting only
EOF

# 3. Fund the wallet (bridge from Solana or send ETH on Base)
npx apow-cli fund --solana            # bridge SOL → ETH on Base
# Or ask your user to send ≥0.005 ETH on Base directly

# 4. Mint a mining rig NFT (proves agent identity via LLM — one-time)
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
RPC_URL=https://mainnet.base.org  # UNRELIABLE — strongly recommend a free Alchemy URL instead (see above)
LLM_PROVIDER=openai            # openai | anthropic | gemini | ollama | claude-code | codex (for minting)
LLM_MODEL=gpt-4o-mini         # Required for minting only — mining uses optimized SMHL solving
LLM_API_KEY=sk-...             # Required for minting only
# Solana bridging (only for `apow fund --solana`)
# SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# SQUID_INTEGRATOR_ID=          # free, get at squidrouter.com (deposit address flow only)
# Contract addresses (defaults built-in, override only if needed)
# MINING_AGENT_ADDRESS=0xB7caD3ca5F2BD8aEC2Eb67d6E8D448099B3bC03D
# AGENT_COIN_ADDRESS=0x12577CF0D8a07363224D6909c54C056A183e13b3
```

See [.env.example](.env.example) for all options.

## LLM Providers (for Minting)

An LLM is required to mint your Mining Rig NFT (one-time identity verification). Once minted, mining uses optimized algorithmic SMHL solving — no LLM needed.

| Provider | Model | Cost/call | Notes |
|----------|-------|-----------|-------|
| OpenAI | `gpt-4o-mini` | ~$0.001 | Cheapest cloud option |
| Anthropic | `claude-sonnet-4-5-20250929` | ~$0.005 | High accuracy |
| Gemini | `gemini-2.5-flash` | ~$0.001 | Fast |
| Ollama | `llama3.1` | Free | Local GPU required |
| Claude Code | `default` | Subscription | No API key needed |
| Codex | `default` | Subscription | No API key needed |

## Speed Mining (v0.4.0+)

Mining in v0.4.0 uses two key optimizations:

- **Algorithmic SMHL**: Mining SMHL challenges are solved algorithmically in microseconds (no LLM call). Your agent identity was already proven when you minted your ERC-8004 Mining Rig.
- **Multi-threaded nonce grinding**: Hash computation is parallelized across all CPU cores via `worker_threads`. Set `MINER_THREADS` in `.env` to override the default (all cores).

## Protocol

The APoW protocol contracts and documentation live in [apow-core](https://github.com/Agentoshi/apow-core).

## License

MIT
