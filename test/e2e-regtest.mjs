// End to end on a private regtest node: real transactions, real signatures, real inscriptions, judged by
// the UNMODIFIED vendor indexer reading blocks over Bitcoin Core RPC.
//
//   launch  rules parent inscribed on chain -> the indexer loads the rules from it
//   mint    MINTN through the platform signer's gate coin; children inscribed under the parent at NUMS
//   send    private transfer Alice -> Bob (self-published)
//   sell    Bob lists, Alice buys through the platform-signed lock; Bob's payout key gets the price
//   cancel  Alice lists, the platform cancels with her signed CLAIM
//   escape  Alice lists, 1008 blocks pass, she takes it back alone through the escape leaf
//   agree   a second indexer replays from scratch and reaches the same state digest
//
// Needs bitcoind (25+) on PATH. Run: npm run test:e2e
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { schnorr } from '@noble/curves/secp256k1.js';
import { makeRpc, makeSource, follower, loadRules } from '../vendor/shielded-ordinals/src/v1/follow.mjs';
import { exportState } from '../vendor/shielded-ordinals/src/v1/view.mjs';
import { vkeyHash } from '../vendor/shielded-ordinals/src/v1/rules.mjs';
import { readInscriptions } from '../vendor/shielded-ordinals/src/v1/inscribe.mjs';
import { artRoot, artProof, verifyArt, fileHash } from '../vendor/shielded-ordinals/src/v1/art.mjs';
import { vaultFromSeed, newSeed, payoutKeyFor, returnKeyFor } from '../packages/sdk/src/keys.mjs';
import { scanState } from '../packages/sdk/src/notes.mjs';
import { buildMint, buildTransfer, buildList, buildBuy, buildClaim, shutdownProver } from '../packages/sdk/src/actions.mjs';
import { mintPsbt, buyPsbt, cancelPsbt, selfPublishPsbt, escapePsbt } from '../packages/sdk/src/txs.mjs';
import { planInscriptions, revealTx, childItems, numsScript, NETWORKS } from '../packages/sdk/src/inscribe.mjs';
import { PlatformSigner, keyPathSigner, xonlyOfPriv } from '../packages/platform/src/policy.mjs';

bitcoin.initEccLib(ecc);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NET = bitcoin.networks.regtest;
const zk = { wasm: ROOT + 'vendor/shielded-ordinals/build/spend_js/spend.wasm', zkey: ROOT + 'zk/dev-ceremony/spend/final.zkey' };
const vkey = JSON.parse(fs.readFileSync(ROOT + 'zk/dev-ceremony/spend/vkey.json', 'utf8'));
const FEE_RATE = 2;
const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

// ─── node ────────────────────────────────────────────────────────────────────────────────────
const DATA = path.join(ROOT, '.regtest');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const RPC_PORT = 18000 + Math.floor(Math.random() * 1000);
const node = spawn('bitcoind', [
  '-regtest', `-datadir=${DATA}`, `-rpcport=${RPC_PORT}`, `-port=${RPC_PORT + 1}`, '-listen=0', '-server', '-txindex=1',
  '-fallbackfee=0.0002', '-datacarriersize=100000', '-acceptnonstdtxn=1', '-printtoconsole=0',
], { stdio: 'ignore' });
const cookie = path.join(DATA, 'regtest', '.cookie');
const nodeRpc = makeRpc(`http://127.0.0.1:${RPC_PORT}`, cookie);
const walletRpc = makeRpc(`http://127.0.0.1:${RPC_PORT}/wallet/funder`, cookie);
let cleanedUp = false;
const cleanup = () => { if (!cleanedUp) { cleanedUp = true; node.kill('SIGTERM'); } };
process.on('exit', cleanup);

for (let i = 0; ; i++) {
  try { if (fs.existsSync(cookie)) { await nodeRpc('getblockcount'); break; } } catch { /* starting */ }
  if (i > 100) throw new Error('bitcoind did not start');
  await new Promise((r) => setTimeout(r, 200));
}
await nodeRpc('createwallet', 'funder');
const minerAddr = await walletRpc('getnewaddress', '', 'bech32m');
const mine = (n = 1) => walletRpc('generatetoaddress', n, minerAddr);
await mine(101);

// a key-path P2TR "wallet" funded from the node wallet
const p2trOf = (priv) => bitcoin.payments.p2tr({ internalPubkey: Buffer.from(xonlyOfPriv(priv), 'hex'), network: NET });
const newPriv = () => Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');
async function fundCoin(script, sats) {
  const address = bitcoin.address.fromOutputScript(script, NET);
  const txid = await walletRpc('sendtoaddress', address, sats / 1e8);
  const tx = await walletRpc('gettransaction', txid);
  const vout = (await nodeRpc('decoderawtransaction', tx.hex)).vout.find((o) => o.scriptPubKey.hex === Buffer.from(script).toString('hex')).n;
  return { txid, vout, value: sats, script: Buffer.from(script) };
}
const send = (hex) => nodeRpc('sendrawtransaction', hex, 0);

// ─── keys and payouts ─────────────────────────────────────────────────────────────────────────
const gatePriv = newPriv(), lockPriv = newPriv(), inscriberPriv = newPriv();
const artist = p2trOf(newPriv()), platformPay = p2trOf(newPriv()), relayerPay = p2trOf(newPriv());
const payerPriv = newPriv();
const payer = p2trOf(payerPriv);
const payerCoin = async (sats) => ({ ...(await fundCoin(payer.output, sats)), tapInternalKey: payer.internalPubkey });
const signPayer = (psbt, from) => { for (let i = from; i < psbt.inputCount; i++) psbt.signInput(i, keyPathSigner(payerPriv)); };

try {
  // ─── launch ───────────────────────────────────────────────────────────────────────────────
  step('launch: art root + rules parent inscribed on chain');
  const art = Array.from({ length: 4 }, (_, i) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`shielded degent #${i} `.repeat(20))]));
  const hashes = art.map(fileHash);
  const rulesJson = {
    p: 'shord', v: 1, name: 'Shielded Degents (regtest)', supply: art.length,
    artRoot: artRoot(hashes).toString('hex'), contentType: 'image/png', inscribeFee: 3000,
    relayerPayoutScript: relayerPay.output.toString('hex'), mintPrice: 50000, artistPayoutScript: artist.output.toString('hex'),
    platformPayoutScript: platformPay.output.toString('hex'), mintFee: 3500, saleFeeBps: 250, saleFeeMin: 1000, ticketPrice: 1500,
    gateKey: xonlyOfPriv(gatePriv), lockKey: xonlyOfPriv(lockPriv), spendVkeyHash: vkeyHash(vkey),
  };
  const revealPriv = schnorr.utils.randomSecretKey();
  const plan = planInscriptions({ network: 'regtest', revealPriv, items: [{ contentType: 'application/json', body: Buffer.from(JSON.stringify(rulesJson)) }] });
  const commit = await fundCoin(plan.commitScript, 20_000);
  const PARENT_VALUE = 10_000;
  const inscriber = p2trOf(inscriberPriv);
  const parentReveal = revealTx({ network: 'regtest', plan, revealPriv, commit, outputs: [{ script: inscriber.output, value: PARENT_VALUE }] });
  await send(parentReveal.hex);
  const [launchHash] = await mine();
  const PARENT_ID = `${parentReveal.txid}i0`;
  const START = (await nodeRpc('getblock', launchHash)).height;
  ok(`parent ${PARENT_ID} at block ${START}`);

  const source = makeSource({ rpc: `http://127.0.0.1:${RPC_PORT}`, rpcCookie: cookie });
  const rules = await loadRules({ source, rulesInscriptionId: PARENT_ID, rulesBlock: launchHash });
  assert.equal(rules.name, rulesJson.name);
  ok('the indexer read the rules from the parent inscription itself');
  const cacheDir = fs.mkdtempSync(path.join(DATA, 'cache-'));
  const chain = follower({ network: 'regtest', source, cacheDir, rulesInscriptionId: PARENT_ID, rules, vkey, startHeight: START });
  const sync = async () => { await chain.sync(); return chain.fresh(); };
  const state = async () => exportState(await sync());
  const platform = new PlatformSigner({ rules, network: NET, gatePriv, lockPriv });
  const gateCoin = await fundCoin(platform.gate, 10_000);
  await mine();

  // ─── mint ─────────────────────────────────────────────────────────────────────────────────
  step('mint: Alice mints pieces 1 and 3 (MINTN, 2 relay tickets each) through the platform gate');
  const alice = vaultFromSeed(newSeed());
  const bob = vaultFromSeed(newSeed());
  const mint = buildMint({ rulesInscriptionId: PARENT_ID, vault: alice, assetIds: [1, 3], ticketsBuy: 2 });
  const m = mintPsbt({ rules, network: NET, gate: gateCoin, mint, count: 2, funding: [await payerCoin(300_000)], changeScript: payer.output, feeRate: FEE_RATE });
  await mine();
  await sync();
  signPayer(m.psbt, 1);
  const verdict = await platform.review(await sync(), m.psbt);
  assert.ok(verdict.ok, verdict.reason);
  m.psbt.finalizeAllInputs();
  const mintTxid = await send(m.psbt.extractTransaction().toHex());
  await mine();
  let mine_a = scanState(alice, await state());
  assert.deepEqual(mine_a.unspent.map((n) => n.assetId).sort(), [1, 3]);
  ok(`mint ${mintTxid.slice(0, 16)}… accepted; Alice's vault holds pieces 1 and 3`);

  // the platform refuses a second mint of the same piece
  const dup = buildMint({ rulesInscriptionId: PARENT_ID, vault: bob, assetIds: [3] });
  const gate2 = await fundCoin(platform.gate, 10_000);
  await mine();
  const d = mintPsbt({ rules, network: NET, gate: gate2, mint: dup, count: 1, funding: [await payerCoin(100_000)], changeScript: payer.output, feeRate: FEE_RATE });
  await mine();
  const refusal = await platform.review(await sync(), d.psbt);
  assert.equal(refusal.ok, false);
  ok(`platform refused a double mint: "${refusal.reason}"`);

  // ─── inscribe children ───────────────────────────────────────────────────────────────────
  step('inscriber: pieces 1 and 3 inscribed as children of the parent, parked at NUMS');
  const POSTAGE = 546;
  const files = [1, 3].map((id) => ({ contentType: 'image/png', body: art[id] }));
  const cPriv = schnorr.utils.randomSecretKey();
  const cPlan = planInscriptions({ network: 'regtest', revealPriv: cPriv, items: childItems({ parentId: PARENT_ID, parentValue: PARENT_VALUE, postage: POSTAGE, files }) });
  const cCommit = await fundCoin(cPlan.commitScript, 30_000);
  await mine();
  const parentCoin = { txid: parentReveal.txid, vout: 0, value: PARENT_VALUE, priv: Buffer.from(inscriberPriv, 'hex') };
  const childReveal = revealTx({
    network: 'regtest', plan: cPlan, revealPriv: cPriv, commit: cCommit, parent: parentCoin,
    outputs: [{ script: inscriber.output, value: PARENT_VALUE }, ...files.map(() => ({ script: numsScript('regtest'), value: POSTAGE }))],
  });
  await send(childReveal.hex);
  await mine();
  const kids = readInscriptions(await nodeRpc('getrawtransaction', childReveal.txid, false));
  assert.equal(kids.length, 2);
  for (const [k, id] of [1, 3].entries()) {
    assert.deepEqual(kids[k].parents, [PARENT_ID]);
    assert.ok(verifyArt(Buffer.from(rules.artRoot, 'hex'), id, fileHash(Buffer.from(kids[k].body)), artProof(hashes, id)));
  }
  ok(`children ${kids.map((k) => k.id.slice(0, 12) + '…' + k.id.slice(-2)).join(', ')} carry parent tag + art Merkle proofs`);

  // ─── private send ────────────────────────────────────────────────────────────────────────
  step('send: Alice privately sends piece 1 to Bob (self-published, spend 0)');
  const p1 = mine_a.unspent.find((n) => n.assetId === 1);
  const tr = await buildTransfer({ rulesInscriptionId: PARENT_ID, vault: alice, note: p1, to: bob.address, state: await state(), zk, spend: 0 });
  const t = selfPublishPsbt({ rules, network: NET, data: tr.data, funding: [await payerCoin(20_000)], changeScript: payer.output, feeRate: FEE_RATE });
  await mine();
  signPayer(t.psbt, 0);
  t.psbt.finalizeAllInputs();
  await send(t.psbt.extractTransaction().toHex());
  await mine();
  const bobs = scanState(bob, await state());
  assert.deepEqual(bobs.unspent.map((n) => n.assetId), [1]);
  ok('Bob found piece 1 by scanning; nothing on chain says it moved from Alice to Bob');

  // ─── list + buy ──────────────────────────────────────────────────────────────────────────
  step('sell: Bob lists piece 1 for 40,000 sats; Alice buys through the platform-signed lock');
  const bn = bobs.unspent[0];
  const payout = payoutKeyFor(bob, bn.nf);
  const sellerScript = Buffer.concat([Buffer.from([0x51, 0x20]), payout.xonly]);
  const li = await buildList({ rulesInscriptionId: PARENT_ID, vault: bob, note: bn, price: 40_000, sellerScript, state: await state(), zk, spend: 0 });
  const lp = selfPublishPsbt({ rules, network: NET, data: li.data, lockFor: li.returnKey, funding: [await payerCoin(20_000)], changeScript: payer.output, feeRate: FEE_RATE });
  await mine();
  signPayer(lp.psbt, 0);
  lp.psbt.finalizeAllInputs();
  await send(lp.psbt.extractTransaction().toHex());
  await mine();
  const listing = (await state()).listings.find((l) => l.state === 'ACTIVE');
  assert.equal(listing.assetId, 1);
  const buy = buildBuy({ rulesInscriptionId: PARENT_ID, vault: alice, listing, ticketsBuy: 1 });
  const bp = buyPsbt({ rules, network: NET, listing, buy, ticketsBuy: 1, funding: [await payerCoin(100_000)], changeScript: payer.output, feeRate: FEE_RATE });
  await mine();
  signPayer(bp.psbt, 1);
  const bv = await platform.review(await sync(), bp.psbt);
  assert.ok(bv.ok, bv.reason);
  bp.psbt.finalizeAllInputs();
  const buyTxid = await send(bp.psbt.extractTransaction().toHex());
  await mine();
  const st = await state();
  assert.equal(st.listings.find((l) => l.nf === listing.nf).state, 'SOLD');
  mine_a = scanState(alice, st);
  assert.deepEqual(mine_a.unspent.map((n) => n.assetId).sort(), [1, 3]);
  const paid = (await nodeRpc('getrawtransaction', buyTxid, true)).vout.find((o) => o.scriptPubKey.hex === sellerScript.toString('hex'));
  assert.equal(Math.round(paid.value * 1e8), 40_000);
  ok('SOLD; Alice holds piece 1 again under a new secret; Bob\'s fresh payout key received 40,000 sats');

  // ─── cancel ──────────────────────────────────────────────────────────────────────────────
  step('cancel: Alice lists piece 3, then the platform cancels it with her signed CLAIM');
  const p3 = mine_a.unspent.find((n) => n.assetId === 3);
  const l3 = await buildList({ rulesInscriptionId: PARENT_ID, vault: alice, note: p3, price: 99_000, sellerScript: artist.output, state: await state(), zk, spend: 0 });
  const l3p = selfPublishPsbt({ rules, network: NET, data: l3.data, lockFor: l3.returnKey, funding: [await payerCoin(20_000)], changeScript: payer.output, feeRate: FEE_RATE });
  await mine();
  signPayer(l3p.psbt, 0);
  l3p.psbt.finalizeAllInputs();
  await send(l3p.psbt.extractTransaction().toHex());
  await mine();
  const listing3 = (await state()).listings.find((l) => l.state === 'ACTIVE' && l.assetId === 3);
  const claim = buildClaim({ rulesInscriptionId: PARENT_ID, vault: alice, listing: listing3 });
  // the platform's own wallet pays the cancel; the payer stands in for it here
  const cp = cancelPsbt({ rules, network: NET, listing: listing3, claim, funding: [await payerCoin(20_000)], changeScript: payer.output, feeRate: FEE_RATE });
  await mine();
  signPayer(cp.psbt, 1);
  const cv = await platform.review(await sync(), cp.psbt);
  assert.ok(cv.ok, cv.reason);
  assert.equal(cv.kind, 'cancel');
  cp.psbt.finalizeAllInputs();
  await send(cp.psbt.extractTransaction().toHex());
  await mine();
  assert.equal((await state()).listings.find((l) => l.nf === listing3.nf).state, 'CLAIMED');
  ok('CLAIMED back into Alice\'s vault');

  // ─── escape ──────────────────────────────────────────────────────────────────────────────
  step('escape: Alice lists piece 3 again, waits 1008 blocks, takes it back alone');
  mine_a = scanState(alice, await state());
  const p3b = mine_a.unspent.find((n) => n.assetId === 3);
  const l3b = await buildList({ rulesInscriptionId: PARENT_ID, vault: alice, note: p3b, price: 99_000, sellerScript: artist.output, state: await state(), zk, spend: 0 });
  const l3bp = selfPublishPsbt({ rules, network: NET, data: l3b.data, lockFor: l3b.returnKey, funding: [await payerCoin(20_000)], changeScript: payer.output, feeRate: FEE_RATE });
  await mine();
  signPayer(l3bp.psbt, 0);
  l3bp.psbt.finalizeAllInputs();
  await send(l3bp.psbt.extractTransaction().toHex());
  await mine();
  const listing3b = (await state()).listings.find((l) => l.state === 'ACTIVE' && l.assetId === 3);
  const esc = buildClaim({ rulesInscriptionId: PARENT_ID, vault: alice, listing: listing3b });
  const escCoin = await payerCoin(20_000);
  const tooEarly = escapePsbt({ rules, network: NET, listing: listing3b, claim: esc, funding: [escCoin], changeScript: payer.output, feeRate: FEE_RATE });
  const ret = returnKeyFor(alice, BigInt(listing3b.nf));
  const leafSigner = { publicKey: Buffer.concat([Buffer.from([2]), ret.xonly]), signSchnorr: (h) => Buffer.from(schnorr.sign(h, ret.priv)) };
  tooEarly.psbt.signInput(0, leafSigner);
  signPayer(tooEarly.psbt, 1);
  tooEarly.psbt.finalizeAllInputs();
  await mine();
  await assert.rejects(send(tooEarly.psbt.extractTransaction().toHex()), /non-BIP68-final/);
  ok('before 1008 blocks the escape leaf is refused by consensus (non-BIP68-final)');
  await mine(1008);
  await send(tooEarly.psbt.extractTransaction().toHex());
  await mine();
  assert.equal((await state()).listings.find((l) => l.nf === listing3b.nf).state, 'CLAIMED');
  ok('after 1008 blocks: CLAIMED with no platform signature');

  // ─── independent replay ──────────────────────────────────────────────────────────────────
  step('agree: a second indexer replays every block from scratch');
  const ix1 = await sync();
  const cache2 = fs.mkdtempSync(path.join(DATA, 'cache-'));
  const chain2 = follower({ network: 'regtest', source: makeSource({ rpc: `http://127.0.0.1:${RPC_PORT}`, rpcCookie: cookie }), cacheDir: cache2, rulesInscriptionId: PARENT_ID, rules, vkey, startHeight: START });
  const ix2 = await chain2.fresh().catch(async () => { await chain2.sync(); return chain2.fresh(); });
  assert.equal(ix2.stateDigest(), ix1.stateDigest());
  const accepted = ix1.log.filter((l) => l.accepted).map((l) => l.type);
  ok(`same digest at block ${ix1.lastHeight}; accepted: ${accepted.join(', ')}`);
  console.log('\nALL E2E CHECKS PASSED');
} finally {
  await shutdownProver();
  cleanup();
}

