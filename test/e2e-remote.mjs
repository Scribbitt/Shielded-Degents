// The "no local node" setup end to end: the platform reads blocks from a hosted node (a fake GetBlock:
// token-in-path RPC, wallet calls refused) and does all hot-wallet I/O through a mempool.space-style
// API; users' wallets read coins from the same API. Backed by regtest so nothing costs real coins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { vaultFromSeed, newSeed } from '../packages/sdk/src/keys.mjs';
import { ShieldedClient, keyPayer, platformUnspent } from '../packages/sdk/src/client.mjs';
import { shutdownProver } from '../packages/sdk/src/actions.mjs';
import { startPlatform } from '../services/platform/server.mjs';
import { startRegtest } from './lib/regtest.mjs';
import { launchCollection } from './lib/launch.mjs';
import { fakeGetBlock, esploraShim } from './lib/remote-fakes.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const zk = { wasm: ROOT + 'vendor/shielded-ordinals/build/spend_js/spend.wasm', zkey: ROOT + 'zk/dev-ceremony/spend/final.zkey' };
const vkey = JSON.parse(fs.readFileSync(ROOT + 'zk/dev-ceremony/spend/vkey.json', 'utf8'));
const ok = (m) => console.log(`  ✓ ${m}`);
const newPriv = () => Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');

const DATA = path.join(ROOT, '.regtest', 'remote');
fs.rmSync(DATA, { recursive: true, force: true });
const rt = await startRegtest(path.join(DATA, 'node'));
const getblock = await fakeGetBlock(rt);
const esplora = await esploraShim(rt);
let platform;
try {
  const keys = { gatePriv: newPriv(), lockPriv: newPriv(), walletPriv: newPriv() };
  const L = await launchCollection(rt, { dir: DATA, supply: 8, keys, vkey });
  platform = await startPlatform({
    network: 'regtest', rpc: getblock.url, api: esplora.url, ...L, spendVkey: vkey, ...keys, gatePool: 3, port: 0,
    stateFile: path.join(DATA, 'state.json'), cacheDir: path.join(DATA, 'cache'), loops: false, log: () => {},
  });
  ok(`platform up: blocks from the hosted node (${getblock.url.replace(getblock.token, '<token>')}), wallet I/O from the API`);

  await platform.tasks.gates();
  await rt.mine();
  const client = new ShieldedClient({ platformUrl: `http://127.0.0.1:${platform.port}`, network: rt.NET, zk });
  await client.load();
  assert.equal((await client.api('GET', '/status')).gates, 3);
  ok('gate pool funded from the hot wallet through the API');

  const coins = async (address) => (await esplora.utxos(address)).map(({ txid, vout, value }) => ({ txid, vout, value }));
  const alice = vaultFromSeed(newSeed()), bob = vaultFromSeed(newSeed());
  const aPay = keyPayer({ priv: newPriv(), network: rt.NET, coins }), bPay = keyPayer({ priv: newPriv(), network: rt.NET, coins });
  await rt.fund(aPay.script, 1_000_000); await rt.fund(bPay.script, 1_000_000); await rt.mine();

  const m = await client.mint({ vault: alice, payer: aPay, count: 2, ticketsPerPiece: 1 });
  await rt.mine(); await client.refresh();
  assert.equal(client.view(alice).unspent.length, 2);
  ok(`mint of pieces ${m.assetIds.join(', ')}: signed, broadcast through the API, indexed from the hosted node`);

  const batch = await platform.tasks.inscribe();
  await rt.mine();
  assert.equal(batch.ids.length, 2);
  ok('inscriber: commit + reveal paid and broadcast through the API');

  const [n1] = client.view(alice).unspent;
  await client.list({ vault: alice, note: n1, price: 77_000 });
  await platform.tasks.relay(); await rt.mine(); await client.refresh();
  const listing = client.market(bob)[0];
  await client.buy({ vault: bob, payer: bPay, listing });
  await rt.mine(); await client.refresh();
  assert.equal(client.view(bob).unspent.length, 1);
  ok('relayed listing + buy');

  const w = await client.withdraw({ vault: alice, toScript: aPay.script, isUnspent: platformUnspent(client) });
  await rt.mine();
  assert.equal(w.amount, 77_000);
  ok('proceeds withdrawn (unspent check through the API)');

  const n2 = client.view(alice).unspent[0];
  await client.list({ vault: alice, note: n2, price: 500_000 });
  await platform.tasks.relay(); await rt.mine(); await client.refresh();
  await client.cancel({ vault: alice, listing: client.view(alice).listings.find((l) => l.state === 'ACTIVE') });
  await rt.mine(); await client.refresh();
  assert.equal(client.view(alice).unspent.length, 1);
  ok('cancel paid by the hot wallet through the API');

  const refused = [...getblock.calls.keys()].filter((k) => /wallet|unspent|scan/.test(k));
  assert.deepEqual(refused, [], `the platform asked the hosted node for wallet calls: ${refused.join(', ')}`);
  ok(`the hosted node only served block calls: ${[...getblock.calls.keys()].sort().join(', ')}`);
  console.log('\nALL REMOTE CHECKS PASSED');
} finally {
  await platform?.close();
  await shutdownProver();
  getblock.close(); esplora.close();
  rt.stop();
}
