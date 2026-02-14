#!/usr/bin/env node
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const LEDGER_PATH = path.join(__dirname, 'ledger.json');
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main';
const RELAYNFT_ORIGIN = 'cdea2c203af755cd9477ca310c61021abaafc135a21d8f93b8ebfc6ca5f95712';

// Known Rexxie txids to seed the indexer
const SEED_TXIDS = [
  'd0ef96ba417631626cfa62053e338422cb788d62945c7ac20dd7237f2bf9809a',
  'ab772754507274d1ba3a9cdf64b8aff2fd81392286711602022d4a5844119134',
];

// ── Ledger ──────────────────────────────────────────────────────────────────
let ledger = {
  collection: {
    name: 'Rexxie',
    protocol: 'Run (BSV)',
    classOrigin: RELAYNFT_ORIGIN,
    description: 'Rexxie NFT collection on BSV via Run token protocol (originally RelayX)',
    totalIndexed: 0,
    lastUpdated: null,
  },
  nfts: {},       // keyed by mint txid (origin)
  owners: {},     // address -> [nft origin txids]
  processed: {},  // txid -> true (set of processed txids)
  queue: [],      // txids to process
};

function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      // Migrate: if processed is array, convert to object
      if (Array.isArray(ledger.processed)) {
        const obj = {};
        for (const t of ledger.processed) obj[t] = true;
        ledger.processed = obj;
      }
      console.log(`Loaded ledger: ${Object.keys(ledger.nfts).length} NFTs, ${Object.keys(ledger.processed).length} processed txs`);
    }
  } catch (e) {
    console.error('Failed to load ledger:', e.message);
  }
}

function saveLedger() {
  ledger.collection.totalIndexed = Object.keys(ledger.nfts).length;
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

async function getTx(txid) {
  return wocGet(`/tx/hash/${txid}`);
}

// ── Run Protocol Decoder ────────────────────────────────────────────────────

function decodeRunPayload(tx) {
  for (const vout of (tx.vout || [])) {
    const asm = vout.scriptPubKey?.asm || '';
    if (!asm.includes('OP_RETURN')) continue;

    try {
      const parts = asm.split(' ');
      const retIdx = parts.indexOf('OP_RETURN');
      if (retIdx < 0) continue;
      const dataparts = parts.slice(retIdx + 1).filter(p => !p.startsWith('OP_'));

      // Check for 'run' tag
      const first = dataparts[0];
      if (first !== '7239026' && first !== '72756e') continue;

      // version is dataparts[1]
      // Remaining parts: app name (optional) + JSON payload
      const decoded = [];
      for (let i = 2; i < dataparts.length; i++) {
        try {
          decoded.push(Buffer.from(dataparts[i], 'hex').toString('utf8'));
        } catch { decoded.push(dataparts[i]); }
      }

      let payload = null;
      let appName = null;
      for (const d of decoded) {
        if (d.startsWith('{')) {
          try { payload = JSON.parse(d); } catch {}
        } else if (!payload) {
          appName = d;
        }
      }

      if (payload) {
        payload._appName = appName;
        return payload;
      }
    } catch {}
  }
  return null;
}

function parseExec(payload) {
  const result = {
    type: null,
    appName: payload._appName || null,
    refs: payload.ref || [],
    numInputs: typeof payload.in === 'number' ? payload.in : 0,
    numOutputs: (payload.out || []).length,
    creates: payload.cre || [],
    deletes: payload.del || [],
    calls: [],
  };

  for (const action of (payload.exec || [])) {
    if (!action || typeof action !== 'object') continue;
    if (action.op === 'CALL' && Array.isArray(action.data)) {
      const jig = action.data[0];
      const method = action.data[1];
      const args = action.data[2] || [];
      result.calls.push({ jig, method, args });
      if (!result.type) result.type = method;
    } else if (action.op === 'DEPLOY') {
      result.type = 'deploy';
    } else if (action.op === 'NEW') {
      result.type = 'new';
    }
  }

  return result;
}

// Resolve address from Run arg (can be string, {$arb: {address, satoshis}}, etc.)
function resolveAddress(arg) {
  if (typeof arg === 'string') return arg;
  if (Array.isArray(arg)) return resolveAddress(arg[0]);
  if (arg && typeof arg === 'object') {
    if (arg.$arb) return arg.$arb.address || null;
    if (arg.address) return arg.address;
  }
  return null;
}

// Check if a tx references the RelayNFT class
function refsRelayNFT(payload) {
  const refs = payload.ref || [];
  return refs.some(r => typeof r === 'string' && r.includes(RELAYNFT_ORIGIN));
}

// ── Indexer ─────────────────────────────────────────────────────────────────

function findNftByLastTx(txid) {
  for (const [origin, nft] of Object.entries(ledger.nfts)) {
    if (nft.lastTx === txid || nft.lastLocation === txid) return origin;
  }
  return null;
}

async function processTx(txid) {
  if (ledger.processed[txid]) return;

  console.log(`Processing: ${txid.slice(0, 16)}...`);
  try {
    const tx = await getTx(txid);
    const payload = decodeRunPayload(tx);

    if (!payload) {
      console.log(`  No Run payload`);
      ledger.processed[txid] = true;
      saveLedger();
      return;
    }

    const exec = parseExec(payload);
    const usesRelayNFT = refsRelayNFT(payload);
    console.log(`  ${exec.type || '?'} | app=${exec.appName || '?'} | relayNFT=${usesRelayNFT}`);

    // Skip non-RelayNFT txs (deploy of OrderLock, etc.)
    if (!usesRelayNFT && exec.type !== 'send') {
      console.log(`  Skipping (not RelayNFT-related)`);
      ledger.processed[txid] = true;
      saveLedger();
      return;
    }

    // ── Handle mint ──
    if (exec.type === 'mint' && usesRelayNFT) {
      for (const call of exec.calls) {
        if (call.method !== 'mint') continue;
        const owner = resolveAddress(call.args[0]);
        const metadata = call.args[1] || {};
        const name = exec.appName || metadata.name || 'Unknown';

        const nft = {
          origin: txid,
          name: metadata.name || name,
          description: metadata.description || '',
          image: metadata.image || null,
          glbModel: metadata.glbModel || null,
          owner: owner || (exec.creates[0] || null),
          creator: exec.creates[0] || null,
          mintTx: txid,
          lastTx: txid,
          blockHeight: tx.blockheight || null,
          blockTime: tx.blocktime || null,
          transfers: [{
            txid, type: 'mint', to: owner,
            blockHeight: tx.blockheight, blockTime: tx.blocktime,
          }],
        };

        ledger.nfts[txid] = nft;
        if (nft.owner) {
          if (!ledger.owners[nft.owner]) ledger.owners[nft.owner] = [];
          if (!ledger.owners[nft.owner].includes(txid)) ledger.owners[nft.owner].push(txid);
        }
        console.log(`  Minted: "${nft.name}" → ${nft.owner || '(no owner)'}`);
      }
    }

    // ── Handle send ──
    if (exec.type === 'send') {
      for (const call of exec.calls) {
        if (call.method !== 'send') continue;
        const sendTo = resolveAddress(call.args[0]);
        const name = exec.appName || 'Unknown';

        // Find which NFT is being sent by checking vin
        // In Run, jig inputs start at vin[1] (vin[0] is funding)
        let originKey = null;
        if (tx.vin && tx.vin.length > 1) {
          const jigVinTxid = tx.vin[1].txid;
          // Check if we know this NFT by its last tx
          originKey = findNftByLastTx(jigVinTxid);
          if (!originKey && ledger.nfts[jigVinTxid]) {
            originKey = jigVinTxid;
          }
          // If unknown, queue the input tx for processing first
          if (!originKey && !ledger.processed[jigVinTxid]) {
            console.log(`  Queueing input tx: ${jigVinTxid.slice(0, 16)}...`);
            if (!ledger.queue.includes(jigVinTxid)) {
              ledger.queue.unshift(jigVinTxid); // process it first
            }
            // Re-queue this tx after the input
            if (!ledger.queue.includes(txid)) {
              ledger.queue.push(txid);
            }
            return; // don't mark as processed yet
          }
        }

        if (originKey && ledger.nfts[originKey]) {
          const nft = ledger.nfts[originKey];
          const oldOwner = nft.owner;
          if (oldOwner && ledger.owners[oldOwner]) {
            ledger.owners[oldOwner] = ledger.owners[oldOwner].filter(id => id !== originKey);
          }
          nft.owner = sendTo;
          nft.lastTx = txid;
          nft.transfers.push({
            txid, type: 'send', to: sendTo,
            blockHeight: tx.blockheight, blockTime: tx.blocktime,
          });
          if (sendTo) {
            if (!ledger.owners[sendTo]) ledger.owners[sendTo] = [];
            if (!ledger.owners[sendTo].includes(originKey)) ledger.owners[sendTo].push(originKey);
          }
          console.log(`  Send: "${nft.name}" → ${sendTo}`);
        } else {
          // Unknown origin — create a partial record
          const key = txid;
          ledger.nfts[key] = {
            origin: key,
            name,
            owner: sendTo,
            mintTx: 'unknown',
            lastTx: txid,
            blockHeight: tx.blockheight,
            blockTime: tx.blocktime,
            transfers: [{ txid, type: 'send (discovered)', to: sendTo, blockHeight: tx.blockheight, blockTime: tx.blocktime }],
          };
          if (sendTo) {
            if (!ledger.owners[sendTo]) ledger.owners[sendTo] = [];
            if (!ledger.owners[sendTo].includes(key)) ledger.owners[sendTo].push(key);
          }
          console.log(`  New NFT from send: "${name}" → ${sendTo}`);
        }
      }
    }

    // ── Handle updateMetadata ──
    if (exec.type === 'updateMetadata') {
      for (const call of exec.calls) {
        if (call.method !== 'updateMetadata') continue;
        const metadata = call.args[0] || {};
        // Find the NFT
        let originKey = null;
        if (tx.vin && tx.vin.length > 1) {
          const jigVinTxid = tx.vin[1].txid;
          originKey = findNftByLastTx(jigVinTxid) || (ledger.nfts[jigVinTxid] ? jigVinTxid : null);
        }
        if (originKey && ledger.nfts[originKey]) {
          const nft = ledger.nfts[originKey];
          if (metadata.name) nft.name = metadata.name;
          if (metadata.description) nft.description = metadata.description;
          if (metadata.image) nft.image = metadata.image;
          if (metadata.glbModel) nft.glbModel = metadata.glbModel;
          nft.metadata = { ...nft.metadata, ...metadata };
          nft.lastTx = txid;
          console.log(`  Updated metadata: "${nft.name}"`);
        }
      }
    }

    ledger.processed[txid] = true;
    saveLedger();
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    console.error(`  Error: ${e.message}`);
    ledger.processed[txid] = true; // skip on error to avoid infinite loop
    saveLedger();
  }
}

async function runIndexer() {
  for (const txid of SEED_TXIDS) {
    if (!ledger.processed[txid] && !ledger.queue.includes(txid)) {
      ledger.queue.push(txid);
    }
  }

  console.log(`Indexer starting. Queue: ${ledger.queue.length}, Processed: ${Object.keys(ledger.processed).length}`);

  let safety = 0;
  while (ledger.queue.length > 0 && safety++ < 100) {
    const txid = ledger.queue.shift();
    await processTx(txid);
  }

  if (safety >= 100) console.log('Indexer hit safety limit (100 txs per run)');
  console.log(`Indexer done. ${Object.keys(ledger.nfts).length} NFTs indexed.`);
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
    endpoints: {
      'GET /collection': 'Collection info and stats',
      'GET /nfts?page=1&limit=50': 'List all indexed NFTs (paginated)',
      'GET /nft/:id': 'NFT details by origin txid',
      'GET /owner/:address': 'NFTs owned by a BSV address',
      'GET /history/:id': 'Transfer history for an NFT',
      'GET /search?q=name': 'Search NFTs by name/description',
      'POST /index': 'Submit txids for indexing { txids: [...] }',
      'POST /reindex': 'Re-run indexer on queued txids',
      'GET /health': 'Health check',
    },
  });
});

app.get('/collection', (req, res) => {
  res.json({
    ...ledger.collection,
    totalNFTs: Object.keys(ledger.nfts).length,
    totalOwners: Object.keys(ledger.owners).filter(a => ledger.owners[a].length > 0).length,
    processedTxs: Object.keys(ledger.processed).length,
    queuedTxs: ledger.queue.length,
  });
});

app.get('/nfts', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const entries = Object.entries(ledger.nfts);
  const start = (page - 1) * limit;

  res.json({
    total: entries.length,
    page,
    limit,
    nfts: entries.slice(start, start + limit).map(([id, nft]) => ({
      id,
      name: nft.name,
      number: nft.number || null,
      owner: nft.owner,
      image: nft.image || null,
      mintTx: nft.mintTx,
      lastTx: nft.lastTx,
      blockHeight: nft.blockHeight,
    })),
  });
});

app.get('/nft/:id', (req, res) => {
  const nft = ledger.nfts[req.params.id];
  if (!nft) return res.status(404).json({ error: 'NFT not found' });
  res.json({ id: req.params.id, ...nft });
});

app.get('/owner/:address', (req, res) => {
  const nftIds = ledger.owners[req.params.address] || [];
  const nfts = nftIds.map(id => ({ id, ...ledger.nfts[id] })).filter(n => n.name);
  res.json({ address: req.params.address, count: nfts.length, nfts });
});

app.get('/history/:id', (req, res) => {
  const nft = ledger.nfts[req.params.id];
  if (!nft) return res.status(404).json({ error: 'NFT not found' });
  res.json({ id: req.params.id, name: nft.name, transfers: nft.transfers || [] });
});

app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json({ results: [] });
  const results = Object.entries(ledger.nfts)
    .filter(([_, nft]) => (nft.name || '').toLowerCase().includes(q) || (nft.description || '').toLowerCase().includes(q))
    .map(([id, nft]) => ({ id, name: nft.name, number: nft.number, owner: nft.owner }));
  res.json({ query: q, count: results.length, results });
});

app.post('/index', async (req, res) => {
  const { txids } = req.body || {};
  let added = 0;
  if (Array.isArray(txids)) {
    for (const txid of txids) {
      if (/^[a-f0-9]{64}$/.test(txid) && !ledger.processed[txid] && !ledger.queue.includes(txid)) {
        ledger.queue.push(txid);
        added++;
      }
    }
  }
  res.json({ status: 'queued', added, queueLength: ledger.queue.length });
  if (added > 0) runIndexer().catch(console.error);
});

app.post('/reindex', async (req, res) => {
  res.json({ status: 'reindexing', queueLength: ledger.queue.length });
  runIndexer().catch(console.error);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), nfts: Object.keys(ledger.nfts).length });
});

// ── Start ───────────────────────────────────────────────────────────────────
loadLedger();

app.listen(PORT, () => {
  console.log(`Rexxie Explorer API running on port ${PORT}`);
  console.log(`http://localhost:${PORT}/`);
  runIndexer().catch(console.error);
});
