#!/usr/bin/env node
'use strict';

// Build spend maps for addresses — stores ONLY txid:vout -> spendingTxid
// Saves to cache/ as JSON. Run separately to avoid memory issues.

const https = require('https');
const fs = require('fs');
const path = require('path');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function wocGet(ep) {
  return new Promise((resolve, reject) => {
    https.get(WOC + ep, { headers: { Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) try { resolve(JSON.parse(d)); } catch { resolve(d); }
        else if (res.statusCode === 429) {
          console.log('  Rate limited, waiting 5s...');
          setTimeout(() => wocGet(ep).then(resolve).catch(reject), 5000);
        }
        else reject(new Error(`WoC ${res.statusCode}`));
      });
    }).on('error', reject);
  });
}

async function buildSpendMap(address) {
  const cacheFile = path.join(CACHE_DIR, `spendmap-${address}.json`);
  if (fs.existsSync(cacheFile)) {
    console.log(`Already cached: ${address}`);
    return;
  }

  console.log(`Building spend map for ${address}...`);
  const history = await wocGet(`/address/${address}/history`);
  console.log(`  ${history.length} txs`);

  const spendMap = {};
  let processed = 0;

  for (const h of history) {
    try {
      const tx = await wocGet(`/tx/hash/${h.tx_hash}`);
      // Record what each input spends
      for (const vin of (tx.vin || [])) {
        spendMap[`${vin.txid}:${vin.vout}`] = h.tx_hash;
      }
      // Also record output addresses for this tx
      // (so the tracer knows where to look next)
      for (const vout of (tx.vout || [])) {
        const addr = vout.scriptPubKey?.addresses?.[0];
        if (addr && vout.value <= 0.00001 && !vout.scriptPubKey?.asm?.includes('OP_RETURN')) {
          // Store dust output addresses for jig tracking
          if (!spendMap._dustOutputs) spendMap._dustOutputs = {};
          spendMap._dustOutputs[`${h.tx_hash}:${vout.n}`] = addr;
        }
      }

      processed++;
      if (processed % 200 === 0) {
        console.log(`  ${processed}/${history.length}`);
      }
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.error(`  Error: ${h.tx_hash.slice(0, 16)}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  fs.writeFileSync(cacheFile, JSON.stringify(spendMap));
  console.log(`  Done. ${Object.keys(spendMap).length} entries. Saved to cache.`);
}

(async () => {
  const address = process.argv[2] || '12nG9uFESfdyE9SdYHVXQeCGFdfYLcdYZG';
  await buildSpendMap(address);
})();
