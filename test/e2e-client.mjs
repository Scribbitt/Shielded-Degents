// The web app's logic (ShieldedClient) end to end against the platform service on regtest, with
// key-backed payers standing in for browser wallets.
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

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const zk = { wasm: ROOT + 'vendor/shielded-ordinals/build/spend_js/spend.wasm', zkey: ROOT + 'zk/dev-ceremony/spend/final.zkey' };
const vkey = JSON.parse(fs.readFileSync(ROOT + 'zk/dev-ceremony/spend/vkey.json', 'utf8'));
const ok = (m) => console.log(`  ✓ ${m}`);
const newPriv = () => Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');

const DATA = path.join(ROOT, '.regtest', 'client');
fs.rmSync(DATA, { recursive: true, force: true });
const rt = await startRegtest(path.join(DATA, 'node'));
const keys = { gatePriv: newPriv(), lockPriv: newPriv(), walletPriv: newPriv() };
const L = await launchCollection(rt, { dir: DATA, supply: 10, keys, vkey });
const platform = await startPlatform({
  network: 'regtest', rpc: rt.url, rpcCookie: rt.cookie, ...L, spendVkey: vkey, ...keys, gatePool: 3, port: 0,
  stateFile: path.join(DATA, 'state.json'), cacheDir: path.join(DATA, 'cache'), loops: false, log: () => {},
});
const coinsOf = async (address) => (await rt.node('scantxoutset', 'start', [`addr(${address})`])).unspents.map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8) }));
const block = async () => { await platform.tasks.relay(); await rt.mine(); await client.refresh(); };

const client = new ShieldedClient({ platformUrl: `http://127.0.0.1:${platform.port}`, network: rt.NET, zk });
try {
  await platform.tasks.gates();
  await rt.mine();
  await client.load();
  ok(`loaded "${client.rules.name}": ${client.unminted().length} unminted, mint ${client.mintCost(1, 2)} sats per piece with 2 tickets`);

  const alice = vaultFromSeed(newSeed()), bob = vaultFromSeed(newSeed());
  const aPay = keyPayer({ priv: newPriv(), network: rt.NET, coins: coinsOf });
  const bPay = keyPayer({ priv: newPriv(), network: rt.NET, coins: coinsOf });
  await rt.fund(aPay.script, 1_000_000); await rt.fund(bPay.script, 1_000_000); await rt.mine();

  const m = await client.mint({ vault: alice, payer: aPay, count: 3, ticketsPerPiece: 1, feeRate: 2 });
  await block();
  assert.equal(client.view(alice).unspent.length, 3);
  ok(`client.mint: pieces ${m.assetIds.join(', ')}`);
  await platform.tasks.inscribe(); await rt.mine();

  const [n1, n2, n3] = client.view(alice).unspent;
  await client.send({ vault: alice, note: n1, to: bob.address });
  await block();
  assert.deepEqual(client.view(bob).unspent.map((n) => n.assetId), [n1.assetId]);
  ok('client.send (relayed, 1 ticket)');

  const bn = client.view(bob).unspent[0];
  assert.equal(bn.tickets, 0);
  await client.send({ vault: bob, note: bn, to: alice.address, payer: bPay, feeRate: 2 });
  await block();
  assert.ok(client.view(alice).unspent.some((n) => n.assetId === n1.assetId));
  ok('client.send (no ticket left: Bob\'s wallet self-published it)');

  await client.list({ vault: alice, note: n2, price: 123_000 });
  await block();
  const listing = client.market(bob)[0];
  assert.equal(listing.assetId, n2.assetId);
  assert.equal(client.market(alice).length, 0, 'your own listings are not in your market');
  ok('client.list (relayed); visible in Bob\'s market, not Alice\'s');

  await client.buy({ vault: bob, payer: bPay, listing, feeRate: 2 });
  await rt.mine(); await client.refresh();
  assert.ok(client.view(bob).unspent.some((n) => n.assetId === n2.assetId));
  assert.equal(client.view(alice).proceeds.length, 1);
  ok('client.buy; Alice has proceeds waiting');

  const w = await client.withdraw({ vault: alice, toScript: aPay.script, isUnspent: platformUnspent(client), feeRate: 2 });
  await rt.mine();
  assert.equal(w.amount, 123_000);
  await assert.rejects(client.withdraw({ vault: alice, toScript: aPay.script, isUnspent: platformUnspent(client), feeRate: 2 }), /no sale proceeds/);
  ok(`client.withdraw swept ${w.amount} sats to Alice's wallet; a second sweep finds nothing`);

  await client.list({ vault: alice, note: n3, price: 999_000 });
  await block();
  const mine = client.view(alice).listings.find((l) => l.state === 'ACTIVE');
  assert.equal(mine.canEscape, false);
  await client.cancel({ vault: alice, listing: mine });
  await rt.mine(); await client.refresh();
  assert.ok(client.view(alice).unspent.some((n) => n.assetId === n3.assetId));
  ok('client.cancel');

  const again = client.view(alice).unspent.find((n) => n.assetId === n3.assetId);
  await client.list({ vault: alice, note: again, price: 5_000_000, payer: aPay, feeRate: 2 });
  await rt.mine(); await client.refresh();
  await rt.mine(1008); await client.refresh();
  const stale = client.view(alice).listings.find((l) => l.state === 'ACTIVE');
  assert.equal(stale.canEscape, true);
  await client.escape({ vault: alice, payer: aPay, listing: stale, feeRate: 2 });
  await rt.mine(); await client.refresh();
  assert.ok(client.view(alice).unspent.some((n) => n.assetId === n3.assetId));
  ok('client.escape after 1008 blocks (self-published listing, no ticket)');

  const r = await fetch(`http://127.0.0.1:${platform.port}/art/${n3.assetId}`);
  assert.equal(r.status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${platform.port}/art/${client.unminted()[0]}`)).status, 404);
  ok('art served for minted pieces only');
  console.log('\nALL CLIENT CHECKS PASSED');
} finally {
  await platform.close();
  await shutdownProver();
  rt.stop();
}
