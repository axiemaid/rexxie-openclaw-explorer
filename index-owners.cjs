#!/usr/bin/env node
'use strict';

// Ownership indexer for Rexxie NFTs
// Uses pre-built spend maps (from build-spendmap.cjs) for fast UTXO tracing
// For addresses not in cache, fetches tx-by-tx (slower but works)

const https = require('https');
const fs = require('fs');
const path = require('path');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const LEDGER_PATH = path.join(__dirname, 'ledger.json');
const CACHE_DIR = path.join(__dirname, 'cache');
const MINTING_ADDR = '12nG9uFESfdyE9SdYHVXQeCGFdfYLcdYZG';
const NFT_VOUT = 3; // NFT jig at vout 3

let ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
console.log(`Loaded ledger: ${Object.keys(ledger.nfts).length} NFTs`);

function saveLedger() {
  ledger.collection.lastUpdated = new Date().toISOString();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function wocGet(ep) {
  return new Promise((resolve, reject) => {
    https.get(WOC + ep, { headers: { Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) try { resolve(JSON.parse(d)); } catch { resolve(d); }
        else if (res.statusCode === 429) {
          setTimeout(() => wocGet(ep).then(resolve).catch(reject), 5000);
        }
        else reject(new Error(`WoC ${res.statusCode}`));
      });
    }).on('error', reject);
  });
}

// Load spend maps from cache
const spendMaps = {};
function loadSpendMap(address) {
  if (spendMaps[address]) return spendMaps[address];
  const cacheFile = path.join(CACHE_DIR, `spendmap-${address}.json`);
  if (fs.existsSync(cacheFile)) {
    spendMaps[address] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return spendMaps[address];
  }
  return null;
}

// Find spending txid for a specific output using cached spend maps
function findSpendInCache(txid, vout, address) {
  const map = loadSpendMap(address);
  if (!map) return null;
  const key = `${txid}:${vout}`;
  const spendingTxid = map[key];
  if (!spendingTxid || typeof spendingTxid !== 'string') return null;
  return spendingTxid;
}

// Get dust output address from cached spend map
function getDustAddr(txid, vout, address) {
  const map = loadSpendMap(address);
  if (!map?._dustOutputs) return null;
  return map._dustOutputs[`${txid}:${vout}`];
}

// Fallback: find spender by fetching tx directly
async function findSpendOnChain(txid, vout, address) {
  if (!address) {
    try {
      const tx = await wocGet(`/tx/hash/${txid}`);
      address = tx.vout[vout]?.scriptPubKey?.addresses?.[0];
      if (!address) return null;
      await new Promise(r => setTimeout(r, 200));
    } catch { return null; }
  }

  try {
    const history = await wocGet(`/address/${address}/history`);
    for (const h of history) {
      if (h.tx_hash === txid) continue;
      const tx = await wocGet(`/tx/hash/${h.tx_hash}`);
      for (const vin of (tx.vin || [])) {
        if (vin.txid === txid && vin.vout === vout) return h.tx_hash;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch {}
  return null; // unspent
}

// Trace a single NFT from mint to current owner
async function traceNFT(num) {
  const nft = ledger.nfts[num];
  if (!nft?.mintTxid) return null;

  let currentTxid = nft.mintTxid;
  let currentVout = NFT_VOUT;
  let currentAddr = MINTING_ADDR;
  let transfers = [{ txid: currentTxid, type: 'mint', to: currentAddr }];
  let hops = 0;

  while (hops < 50) {
    // Try cache first, then on-chain
    let spendingTxid = findSpendInCache(currentTxid, currentVout, currentAddr);

    if (!spendingTxid) {
      // Try on-chain lookup (slow)
      spendingTxid = await findSpendOnChain(currentTxid, currentVout, currentAddr);
    }

    if (!spendingTxid) break; // unspent = current holder

    hops++;

    // Find NFT jig in spending tx: first dust output
    // Try cache first
    let newAddr = null;
    let newVout = null;

    // Check cached dust outputs for this tx
    const map = loadSpendMap(currentAddr);
    if (map?._dustOutputs) {
      // Find dust outputs from this spending tx
      for (const [key, addr] of Object.entries(map._dustOutputs)) {
        if (key.startsWith(spendingTxid + ':')) {
          newAddr = addr;
          newVout = parseInt(key.split(':')[1]);
          break; // first dust output
        }
      }
    }

    // If not in cache, fetch the tx
    if (!newAddr) {
      try {
        const tx = await wocGet(`/tx/hash/${spendingTxid}`);
        for (const vout of tx.vout) {
          if (vout.scriptPubKey?.asm?.includes('OP_RETURN')) continue;
          const addr = vout.scriptPubKey?.addresses?.[0];
          if (addr && vout.value <= 0.00001) {
            newAddr = addr;
            newVout = vout.n;
            break;
          }
        }
        await new Promise(r => setTimeout(r, 200));
      } catch { break; }
    }

    if (!newAddr) break;

    if (newAddr !== currentAddr) {
      transfers.push({
        txid: spendingTxid,
        type: 'send',
        from: currentAddr,
        to: newAddr,
        blockHeight: null,
      });
    }

    currentAddr = newAddr;
    currentVout = newVout;
    currentTxid = spendingTxid;
  }

  return { owner: currentAddr, transfers, hops };
}

// Main
(async () => {
  const startNum = parseInt(process.argv[2]) || 1;
  const batchSize = parseInt(process.argv[3]) || 2222;

  // Check minting address spend map exists
  if (!loadSpendMap(MINTING_ADDR)) {
    console.error('ERROR: No spend map for minting address. Run build-spendmap.cjs first.');
    process.exit(1);
  }

  const nums = Object.keys(ledger.nfts)
    .map(Number)
    .filter(n => n >= startNum && !ledger.nfts[n].owner)
    .sort((a, b) => a - b)
    .slice(0, batchSize);

  console.log(`${nums.length} NFTs to index\n`);

  let indexed = 0;
  for (const num of nums) {
    try {
      const result = await traceNFT(num);
      if (result) {
        const nft = ledger.nfts[num];
        nft.owner = result.owner;
        nft.lastTx = result.transfers[result.transfers.length - 1]?.txid;
        nft.transfers = result.transfers;

        if (!ledger.owners[result.owner]) ledger.owners[result.owner] = [];
        if (!ledger.owners[result.owner].includes(num)) ledger.owners[result.owner].push(num);

        indexed++;

        const isTransferred = result.owner !== MINTING_ADDR;
        if (isTransferred) {
          console.log(`#${num}: ${result.transfers.length - 1} sends → ${result.owner}`);
        }

        if (indexed % 50 === 0) {
          ledger.ownershipIndexed = Object.values(ledger.nfts).filter(n => n.owner).length;
          saveLedger();
          const uniqueOwners = new Set(Object.values(ledger.nfts).map(n => n.owner).filter(Boolean)).size;
          console.log(`--- Saved. ${indexed} done, ${uniqueOwners} unique owners ---`);
        }
      }
    } catch (e) {
      console.error(`#${num} error: ${e.message}`);
    }
  }

  ledger.ownershipIndexed = Object.values(ledger.nfts).filter(n => n.owner).length;
  saveLedger();
  const uniqueOwners = new Set(Object.values(ledger.nfts).map(n => n.owner).filter(Boolean)).size;
  console.log(`\nDone. ${indexed} indexed. ${uniqueOwners} unique owners.`);
})();
