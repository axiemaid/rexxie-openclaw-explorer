# Rexxie Indexer

On-chain indexer for the **Rexxie** NFT collection on BSV (Bitcoin SV), built with the [Run protocol](https://run.network).

**Public API:** https://rexxie.axiemaid.com
**Explorer Skill:** [rexxie-explorer-skill](https://github.com/axiemaid/rexxie-explorer-skill) — OpenClaw skill for agent-driven exploration

## Collection

- **Name:** Rexxie
- **Total:** 2,222 NFTs
- **Protocol:** Run (BSV)
- **Deploy TX:** [`12d8ca4bc0eaf26660627cc1671de6a0047246f39f3aa06633f8204223d70cc5`](https://whatsonchain.com/tx/12d8ca4bc0eaf26660627cc1671de6a0047246f39f3aa06633f8204223d70cc5) (block 771,246)
- **Description:** "RelayX wishes you a Merry Christmas and Happy New Year."

## Current Status

- ✅ All 2,222 NFTs discovered and indexed (mint txids, traits, images)
- ✅ Full ownership traced using orderlock-first logic
- ✅ Incremental refresh with burn detection
- ✅ 2,222 local images downloaded
- ✅ API endpoints serving collection data (public at rexxie.axiemaid.com)
- ✅ OpenClaw skill for agent-driven exploration ([rexxie-explorer-skill](https://github.com/axiemaid/rexxie-explorer-skill))

## Architecture

- **Data:** `ledger.json` — single source of truth (collection metadata, all NFTs, owners index, transfer histories)
- **API:** Node.js Express server on port 3001
- **Chain data:** [WhatsOnChain API](https://developers.whatsonchain.com/) (free, no auth)

### Ownership Indexing

Uses **orderlock-first logic** to correctly trace NFT ownership through RelayX marketplace listings:
1. Check for nonstandard outputs first (OrderLock = marketplace escrow, skip address update)
2. Then check dust P2PKH outputs (normal send/transfer)
3. Follow the UTXO chain from mint to current holder

**Burn detection:** When a spending tx has no recognizable jig output (e.g. consolidation sweep), the NFT is marked `burned: true` with last known owner preserved.

## Scripts

| Script | Purpose |
|---|---|
| `discover.cjs` | Scan minting address to find all Rexxie mints |
| `index-owners.cjs` | Initial full ownership indexing from mint to current holder |
| `refresh-owners.cjs` | Incremental ownership refresh (1 API call per unchanged NFT) |
| `backfill-vout.cjs` | One-time: cache `lastVout` in ledger to optimize refresh |
| `download-images.cjs` | Bulk download NFT images locally |
| `explorer.cjs` | Express API server |

### Refresh Script Features

- Starts from `lastTx`/`lastVout` instead of re-tracing from mint
- 3 retries with exponential backoff (2s → 4s → 8s)
- 30s HTTP timeout
- Adaptive rate limiting (auto-slows on 429s, speeds up on success)
- Retry queue (2 rounds for failed NFTs)
- Skips burned NFTs
- Auto-logs every run to `logs/`

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Overview |
| `GET /collection` | Collection metadata |
| `GET /nfts` | List NFTs (paginated via `?page=&limit=`) |
| `GET /nft/:number` | Single NFT by number |
| `GET /nft/tx/:txid` | Lookup NFT by transaction ID |
| `GET /owner/:address` | NFTs owned by a BSV address |
| `GET /traits` | Trait type distribution |
| `GET /traits/:type/:value` | NFTs with a specific trait |
| `GET /search` | Search NFTs (by number, name, address) |
| `GET /random` | Random NFT |
| `GET /stats` | Collection statistics |
| `GET /health` | Health check |

## Setup

```bash
npm install
```

### Index the collection (first time)

```bash
node discover.cjs          # Find all mints
node index-owners.cjs      # Trace ownership (takes hours)
node backfill-vout.cjs     # Cache lastVout for fast refresh
node download-images.cjs   # Download images locally
```

### Run the API

```bash
node explorer.cjs
# Listening on http://localhost:3001
```

### Refresh ownership

```bash
node refresh-owners.cjs
# ~20 min for full collection, logs to logs/
```

## Data Files (gitignored)

| File | Description |
|---|---|
| `ledger.json` | All NFT data, owners, transfer histories (~2.7MB) |
| `images/` | 2,222 downloaded NFT images |
| `cache/` | Spendmap cache for discovery |
| `logs/` | Refresh run logs |

## Technical Notes

- **Minting address:** `12nG9uFESfdyE9SdYHVXQeCGFdfYLcdYZG` (shared across all RelayX collections — 6,399 txs)
- **COL deploy tx:** `12d8ca4bc0eaf26660627cc1671de6a0047246f39f3aa06633f8204223d70cc5`
- **Class ref:** `_o2` = Rexxie `COL extends RelayNFT`
- **Generic RelayNFT origin:** `cdea2c203af755cd9477ca310c61021abaafc135a21d8f93b8ebfc6ca5f95712`
- Mint txs reference the generic RelayNFT, NOT the Rexxie COL directly — COL is a jig input, not a ref
- Images are encrypted (`relay.encrypted-nft`), RelayX is inactive — local copies are the fallback
