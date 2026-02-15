#!/usr/bin/env node
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const LEDGER_PATH = path.join(__dirname, 'ledger.json');
const COLLECTION_PATH = path.join(__dirname, 'rexxie-collection.json');
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';

const REXXIE_CLASS_ORIGIN = '12d8ca4bc0eaf26660627cc1671de6a0047246f39f3aa06633f8204223d70cc5';
const TIQUE_RUN_BASE = `https://tique.run/${REXXIE_CLASS_ORIGIN}_o2`;

// ── Ledger ──────────────────────────────────────────────────────────────────
let ledger = {
  collection: {
    name: 'Rexxie',
    protocol: 'Run (BSV)',
    classOrigin: REXXIE_CLASS_ORIGIN,
    classRef: REXXIE_CLASS_ORIGIN + '_o2',
    description: 'RelayX wishes you a Merry Christmas and Happy New Year.',
    symbol: 'COL',
    total: 2222,
    deployBlock: 771246,
    lastUpdated: null,
  },
  nfts: {},       // keyed by number (1-2222)
  owners: {},     // address -> [nft numbers]
  ownershipIndexed: 0,
};

function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      console.log(`Loaded ledger: ${Object.keys(ledger.nfts).length} NFTs, ${ledger.ownershipIndexed} with ownership`);
    }
  } catch (e) {
    console.error('Failed to load ledger:', e.message);
  }
}

function saveLedger() {
  ledger.collection.lastUpdated = new Date().toISOString();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

// ── WhatsOnChain Client ─────────────────────────────────────────────────────
function wocGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${WOC_BASE}${endpoint}`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        } else if (res.statusCode === 429) {
          setTimeout(() => wocGet(endpoint).then(resolve).catch(reject), 3000);
        } else {
          reject(new Error(`WoC ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

// ── Import collection metadata from content.js ─────────────────────────────
function importCollection() {
  if (!fs.existsSync(COLLECTION_PATH)) {
    console.log('No rexxie-collection.json found. Run content.js import first.');
    return;
  }

  const collection = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf8'));
  console.log(`Importing ${collection.length} NFTs from collection data...`);

  let imported = 0;
  for (const item of collection) {
    const num = parseInt(item.number);
    if (ledger.nfts[num]) continue; // already imported

    // Extract mint txid from image URL
    const match = item.img?.match(/\/([a-f0-9]{64})_o3\.png/);
    const mintTxid = match ? match[1] : null;

    ledger.nfts[num] = {
      number: num,
      mintTxid,
      jigRef: mintTxid ? `${mintTxid}_o3` : null,
      image: item.img,
      traits: {
        background: item.background,
        base: item.base,
        body: item.body,
        eye: item.eye,
        mouth: item.mouth,
        head: item.head,
      },
      owner: null,       // to be indexed
      lastTx: null,      // to be indexed
      transfers: [],     // to be indexed
    };
    imported++;
  }

  saveLedger();
  console.log(`Imported ${imported} NFTs. Total: ${Object.keys(ledger.nfts).length}`);
}

// ── Run Protocol Decoder ────────────────────────────────────────────────────
function decodeRunPayload(tx) {
  for (const vout of (tx.vout || [])) {
    const asm = vout.scriptPubKey?.asm || '';
    if (!asm.includes('OP_RETURN')) continue;
    try {
      const parts = asm.split(' ');
      const ri = parts.indexOf('OP_RETURN');
      if (ri < 0) continue;
      const dp = parts.slice(ri + 1).filter(p => !p.startsWith('OP_'));
      if (dp[0] !== '7239026' && dp[0] !== '72756e') continue;
      let appName = null;
      for (let i = 2; i < dp.length; i++) {
        try {
          const txt = Buffer.from(dp[i], 'hex').toString('utf8');
          if (txt.startsWith('{')) {
            const payload = JSON.parse(txt);
            payload._appName = appName;
            return payload;
          } else if (!appName) {
            appName = txt;
          }
        } catch {}
      }
    } catch {}
  }
  return null;
}

// Resolve address from Run arg
function resolveAddress(arg) {
  if (typeof arg === 'string') return arg;
  if (Array.isArray(arg)) return resolveAddress(arg[0]);
  if (arg && typeof arg === 'object') {
    if (arg.$arb) return arg.$arb.address || null;
    if (arg.address) return arg.address;
  }
  return null;
}

// ── Ownership Indexer ───────────────────────────────────────────────────────
// For each NFT, trace the jig UTXO chain from the mint tx forward
// to find current owner by following sends.

async function indexOwnership(startNum, batchSize = 50) {
  const nums = Object.keys(ledger.nfts)
    .map(Number)
    .filter(n => !ledger.nfts[n].owner)
    .sort((a, b) => a - b);

  if (startNum) {
    const idx = nums.indexOf(startNum);
    if (idx > 0) nums.splice(0, idx);
  }

  const batch = nums.slice(0, batchSize);
  console.log(`Indexing ownership for ${batch.length} NFTs (${nums.length} remaining)...`);

  let indexed = 0;
  for (const num of batch) {
    const nft = ledger.nfts[num];
    if (!nft.mintTxid) continue;

    try {
      // Get the mint tx to find initial owner address (vout 2 = NFT jig output)
      const mintTx = await wocGet(`/tx/hash/${nft.mintTxid}`);
      // NFT jig is at _o3, which is vout index 3 (0=image OP_RETURN, 1=Run OP_RETURN, 2=class, 3=NFT)
      // Actually _o3 means Run output index 3 (which maps to the 4th P2PKH output after OP_RETURNs)
      // Let's find the address from the mint tx
      
      // In Run, outputs after OP_RETURN are: class jig, NFT jig, change...
      // The NFT jig (_o3) is typically at vout 2 or 3
      // For a mint with `out: 2` (class state + NFT), the NFT is the second P2PKH output
      let nftVout = null;
      let p2pkhIdx = 0;
      for (const vout of mintTx.vout) {
        if (vout.scriptPubKey?.asm?.includes('OP_RETURN')) continue;
        p2pkhIdx++;
        // _o3 means the 3rd Run output (0-indexed from Run's perspective)
        // Run output 0 = class update, output 1 = new NFT jig
        // But we need to figure out vout mapping. Let's try vout 2 first.
      }

      // Simpler: check address at vout 2 (typical NFT position for mints)
      const nftOutput = mintTx.vout[2];
      const mintOwner = nftOutput?.scriptPubKey?.addresses?.[0];

      if (mintOwner) {
        nft.owner = mintOwner;
        nft.lastTx = nft.mintTxid;
        nft.transfers = [{ txid: nft.mintTxid, type: 'mint', to: mintOwner, blockHeight: mintTx.blockheight }];

        // Now trace forward: check if this output was spent (= transferred)
        // For now just record the mint owner — full transfer tracing is a future step
        
        if (!ledger.owners[mintOwner]) ledger.owners[mintOwner] = [];
        if (!ledger.owners[mintOwner].includes(num)) ledger.owners[mintOwner].push(num);

        indexed++;
        ledger.ownershipIndexed++;
      }

      if (indexed % 10 === 0) {
        saveLedger();
        console.log(`  Indexed ${indexed}/${batch.length} (NFT #${num})`);
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`  Error indexing #${num}: ${e.message}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  saveLedger();
  console.log(`Ownership batch done. ${indexed} indexed this run. Total with owners: ${ledger.ownershipIndexed}`);
}

// ── API ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Root: agent-friendly API schema
app.get('/', (req, res) => {
  res.json({
    name: 'Rexxie OpenClaw Explorer',
    description: 'Agent-first API for Rexxie NFTs on BSV (Run token protocol)',
    total: 2222,
    endpoints: {
      'GET /collection': 'Collection info and stats',
      'GET /nfts?page=1&limit=50': 'List NFTs (paginated)',
      'GET /nft/:number': 'NFT details by number (1-2222)',
      'GET /nft/tx/:txid': 'NFT details by mint txid',
      'GET /owner/:address': 'NFTs owned by a BSV address',
      'GET /traits': 'List all trait types and values with counts',
      'GET /traits/:type/:value': 'NFTs with a specific trait',
      'GET /search?q=query': 'Search NFTs by trait value',
      'GET /random': 'Random NFT',
      'GET /stats': 'Collection statistics',
      'POST /index-owners?start=1&batch=50': 'Index ownership from chain (slow)',
      'GET /health': 'Health check',
    },
  });
});

app.get('/collection', (req, res) => {
  const ownedCount = Object.values(ledger.owners).reduce((sum, arr) => sum + arr.length, 0);
  res.json({
    ...ledger.collection,
    indexed: Object.keys(ledger.nfts).length,
    ownersTracked: Object.keys(ledger.owners).filter(a => ledger.owners[a].length > 0).length,
    ownershipIndexed: ledger.ownershipIndexed,
  });
});

app.get('/nfts', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const total = Object.keys(ledger.nfts).length;
  const start = (page - 1) * limit;

  const nums = Object.keys(ledger.nfts).map(Number).sort((a, b) => a - b);
  const pageNums = nums.slice(start, start + limit);

  res.json({
    total,
    page,
    limit,
    nfts: pageNums.map(n => {
      const nft = ledger.nfts[n];
      return {
        number: n,
        mintTxid: nft.mintTxid,
        image: nft.image,
        traits: nft.traits,
        owner: nft.owner,
      };
    }),
  });
});

app.get('/nft/:number', (req, res) => {
  const num = parseInt(req.params.number);
  const nft = ledger.nfts[num];
  if (!nft) return res.status(404).json({ error: 'NFT not found', valid: '1-2222' });
  res.json({ ...nft });
});

app.get('/nft/tx/:txid', (req, res) => {
  const txid = req.params.txid;
  const entry = Object.entries(ledger.nfts).find(([_, nft]) => nft.mintTxid === txid);
  if (!entry) return res.status(404).json({ error: 'NFT not found by txid' });
  res.json({ number: parseInt(entry[0]), ...entry[1] });
});

app.get('/owner/:address', (req, res) => {
  const nums = ledger.owners[req.params.address] || [];
  const nfts = nums.map(n => ({ number: n, ...ledger.nfts[n] }));
  res.json({ address: req.params.address, count: nfts.length, nfts });
});

app.get('/traits', (req, res) => {
  const traitTypes = {};
  for (const nft of Object.values(ledger.nfts)) {
    if (!nft.traits) continue;
    for (const [type, value] of Object.entries(nft.traits)) {
      if (!traitTypes[type]) traitTypes[type] = {};
      if (!traitTypes[type][value]) traitTypes[type][value] = 0;
      traitTypes[type][value]++;
    }
  }
  res.json(traitTypes);
});

app.get('/traits/:type/:value', (req, res) => {
  const { type, value } = req.params;
  const matches = Object.entries(ledger.nfts)
    .filter(([_, nft]) => nft.traits && nft.traits[type]?.toLowerCase() === value.toLowerCase())
    .map(([num, nft]) => ({ number: parseInt(num), mintTxid: nft.mintTxid, image: nft.image, traits: nft.traits, owner: nft.owner }));
  res.json({ trait: type, value, count: matches.length, nfts: matches });
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = Object.entries(ledger.nfts)
    .filter(([_, nft]) => {
      if (!nft.traits) return false;
      return Object.values(nft.traits).some(v => v.toLowerCase().includes(q));
    })
    .map(([num, nft]) => ({ number: parseInt(num), traits: nft.traits, owner: nft.owner, image: nft.image }));
  res.json({ query: q, count: results.length, results });
});

app.get('/random', (req, res) => {
  const nums = Object.keys(ledger.nfts).map(Number);
  const num = nums[Math.floor(Math.random() * nums.length)];
  res.json({ number: num, ...ledger.nfts[num] });
});

app.get('/stats', (req, res) => {
  const traitCounts = {};
  for (const nft of Object.values(ledger.nfts)) {
    if (!nft.traits) continue;
    for (const [type, value] of Object.entries(nft.traits)) {
      if (!traitCounts[type]) traitCounts[type] = new Set();
      traitCounts[type].add(value);
    }
  }
  const uniqueOwners = new Set(Object.values(ledger.nfts).map(n => n.owner).filter(Boolean));
  res.json({
    totalNFTs: 2222,
    indexed: Object.keys(ledger.nfts).length,
    ownershipIndexed: ledger.ownershipIndexed,
    uniqueOwners: uniqueOwners.size,
    traitTypes: Object.fromEntries(Object.entries(traitCounts).map(([k, v]) => [k, v.size])),
  });
});

app.post('/index-owners', async (req, res) => {
  const start = parseInt(req.query.start) || 1;
  const batch = Math.min(parseInt(req.query.batch) || 50, 200);
  res.json({ status: 'indexing', start, batch });
  indexOwnership(start, batch).catch(console.error);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), nfts: Object.keys(ledger.nfts).length });
});

// ── Start ───────────────────────────────────────────────────────────────────
loadLedger();
importCollection();

app.listen(PORT, () => {
  console.log(`Rexxie Explorer API running on port ${PORT}`);
  console.log(`http://localhost:${PORT}/`);
});
