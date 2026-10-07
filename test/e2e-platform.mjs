// The platform service over HTTP, as the web app uses it, on a private regtest node:
//   reserve a gate coin -> mint (client builds + signs, platform co-signs) -> broadcast
//   inscriber turns minted pieces into children of the parent at NUMS
//   relayed private send + relayed listing, published in one batch from the platform's hot wallet
//   buy through /sign, cancel through /cancel, read everything back from /state and /listings
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { schnorr } from '@noble/curves/secp256k1.js';
import { vkeyHash } from '../vendor/shielded-ordinals/src/v1/rules.mjs';
import { readInscriptions } from '../vendor/shielded-ordinals/src/v1/inscribe.mjs';
import { artRoot, fileHash } from '../vendor/shielded-ordinals/src/v1/art.mjs';
import { vaultFromSeed, newSeed, payoutKeyFor } from '../packages/sdk/src/keys.mjs';
import { scanState } from '../packages/sdk/src/notes.mjs';
import { buildMint, buildTransfer, buildList, buildBuy, buildClaim, shutdownProver } from '../packages/sdk/src/actions.mjs';
import { mintPsbt, buyPsbt } from '../packages/sdk/src/txs.mjs';
import { planInscriptions, revealTx } from '../packages/sdk/src/inscribe.mjs';
import { keyPathSigner, xonlyOfPriv } from '../packages/platform/src/policy.mjs';
import { startPlatform } from '../services/platform/server.mjs';
import { startRegtest } from './lib/regtest.mjs';

bitcoin.initEccLib(ecc);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const zk = { wasm: ROOT + 'vendor/shielded-ordinals/build/spend_js/spend.wasm', zkey: ROOT + 'zk/dev-ceremony/spend/final.zkey' };
const vkey = JSON.parse(fs.readFileSync(ROOT + 'zk/dev-ceremony/spend/vkey.json', 'utf8'));
const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

const DATA = path.join(ROOT, '.regtest', 'platform');
fs.rmSync(DATA, { recursive: true, force: true });
const rt = await startRegtest(path.join(DATA, 'node'));
const NET = rt.NET;
const newPriv = () => Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');
const p2trOf = (priv) => bitcoin.payments.p2tr({ internalPubkey: Buffer.from(xonlyOfPriv(priv), 'hex'), network: NET });

const gatePriv = newPriv(), lockPriv = newPriv(), walletPriv = newPriv(), payerPriv = newPriv();
const hot = p2trOf(walletPriv), payer = p2trOf(payerPriv);
const artist = p2trOf(newPriv()), platformPay = p2trOf(newPriv());
const payerCoin = async (sats) => ({ ...(await rt.fund(payer.output, sats)), tapInternalKey: payer.internalPubkey });
const signPayer = (psbt) => psbt.data.inputs.forEach((inp, i) => { if (Buffer.from(inp.witnessUtxo.script).equals(payer.output)) psbt.signInput(i, keyPathSigner(payerPriv)); });

let platform;
try {
  step('launch: art + rules parent (held by the platform hot wallet)');
  const artDir = path.join(DATA, 'art');
  fs.mkdirSync(artDir, { recursive: true });
  const art = Array.from({ length: 6 }, (_, i) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(`degent ${i} `.repeat(30))]));
  art.forEach((b, i) => fs.writeFileSync(path.join(artDir, `${i}.png`), b));
  const rulesJson = {
    p: 'shord', v: 1, name: 'Shielded Degents (regtest platform)', supply: art.length, artRoot: artRoot(art.map(fileHash)).toString('hex'),
    contentType: 'image/png', inscribeFee: 3000, relayerPayoutScript: hot.output.toString('hex'), mintPrice: 50000,
    artistPayoutScript: artist.output.toString('hex'), platformPayoutScript: platformPay.output.toString('hex'), mintFee: 3500,
    saleFeeBps: 250, saleFeeMin: 1000, ticketPrice: 1500, gateKey: xonlyOfPriv(gatePriv), lockKey: xonlyOfPriv(lockPriv), spendVkeyHash: vkeyHash(vkey),
  };
  const rp = schnorr.utils.randomSecretKey();
  const plan = planInscriptions({ network: 'regtest', revealPriv: rp, items: [{ contentType: 'application/json', body: Buffer.from(JSON.stringify(rulesJson)) }] });
  const commit = await rt.fund(plan.commitScript, 20_000);
  const reveal = revealTx({ network: 'regtest', plan, revealPriv: rp, commit, outputs: [{ script: hot.output, value: 10_000 }] });
  await rt.send(reveal.hex);
  const [rulesBlock] = await rt.mine();
  const START = (await rt.node('getblock', rulesBlock)).height;
  const PARENT_ID = `${reveal.txid}i0`;
  for (let i = 0; i < 4; i++) await rt.fund(hot.output, 200_000); // the hot wallet's working float
  await rt.mine();
  ok(PARENT_ID);

  step('start the platform service');
  platform = await startPlatform({
    network: 'regtest', rpc: rt.url, rpcCookie: rt.cookie, rulesInscriptionId: PARENT_ID, rulesBlock, startHeight: START, spendVkey: vkey,
    gatePriv, lockPriv, walletPriv, parentOutpoint: `${reveal.txid}:0:10000`, artDir, gatePool: 3, port: 0,
    stateFile: path.join(DATA, 'platform-state.json'), cacheDir: path.join(DATA, 'cache'), loops: false, log: () => {},
  });
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${platform.port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
    return j;
  };
  await platform.tasks.gates();
  await rt.mine();
  const status = await api('GET', '/status');
  assert.equal(status.gates, 3);
  ok(`up: ${status.collection}, ${status.gates} gate coins`);
  const { rules } = await api('GET', '/collection');
  const R = { ...rules, artistScript: artist.output, platformScript: platformPay.output, relayerScript: hot.output };

  step('mint over HTTP: reserve gate -> client builds + signs -> /sign -> /broadcast');
  const alice = vaultFromSeed(newSeed()), bob = vaultFromSeed(newSeed());
  const fundA = await payerCoin(400_000);
  await rt.mine();
  const { gate } = await api('POST', '/mint/reserve');
  const mint = buildMint({ rulesInscriptionId: PARENT_ID, vault: alice, assetIds: [0, 4, 5], ticketsBuy: 2 });
  const mp = mintPsbt({ rules: R, network: NET, gate, mint, count: 3, funding: [fundA], changeScript: payer.output, feeRate: 2 }).psbt;
  signPayer(mp);
  const signed = bitcoin.Psbt.fromBase64((await api('POST', '/sign', { psbt: mp.toBase64() })).psbt, { network: NET });
  signed.finalizeAllInputs();
  await api('POST', '/broadcast', { hex: signed.extractTransaction().toHex() });
  await rt.mine();
  let state = await api('GET', '/state');
  assert.deepEqual(scanState(alice, state).unspent.map((n) => n.assetId).sort(), [0, 4, 5]);
  ok('pieces 0, 4, 5 minted into Alice\'s vault');
  await assert.rejects(api('POST', '/sign', { psbt: mp.toBase64() }), /already minted|exactly one/);
  ok('re-signing the same mint is refused');

  step('inscriber: minted pieces become children of the parent');
  const batch = await platform.tasks.inscribe();
  await rt.mine();
  assert.deepEqual(batch.ids, [0, 4, 5]);
  const kids = readInscriptions(await rt.node('getrawtransaction', batch.revealTxid, false));
  assert.equal(kids.length, 3);
  kids.forEach((k, i) => { assert.deepEqual(k.parents, [PARENT_ID]); assert.ok(Buffer.from(k.body).equals(art[batch.ids[i]])); });
  const second = await platform.tasks.inscribe();
  assert.equal(second, null);
  ok(`${kids.length} children inscribed in ${batch.revealTxid.slice(0, 16)}…; nothing left to inscribe`);

  step('relay: Alice privately sends piece 4 to Bob and lists piece 5; both go out in ONE batch');
  state = await api('GET', '/state');
  const a = scanState(alice, state).unspent;
  const tr = await buildTransfer({ rulesInscriptionId: PARENT_ID, vault: alice, note: a.find((n) => n.assetId === 4), to: bob.address, state, zk });
  const p5 = a.find((n) => n.assetId === 5);
  const payout = payoutKeyFor(alice, p5.nf);
  const sellerScript = Buffer.concat([Buffer.from([0x51, 0x20]), payout.xonly]);
  const li = await buildList({ rulesInscriptionId: PARENT_ID, vault: alice, note: p5, price: 70_000, sellerScript, state, zk });
  const r1 = await api('POST', '/relay', { envelopeHex: tr.data.toString('hex') });
  const r2 = await api('POST', '/relay', { envelopeHex: li.data.toString('hex') });
  await assert.rejects(api('POST', '/relay', { envelopeHex: tr.data.toString('hex') }), /double spend/);
  const flushed = await platform.tasks.relay();
  await rt.mine();
  assert.equal(flushed.count, 2);
  assert.equal((await api('GET', `/relay/${r1.id}`)).txid, flushed.txid);
  assert.equal((await api('GET', `/relay/${r2.id}`)).txid, flushed.txid);
  state = await api('GET', '/state');
  assert.deepEqual(scanState(bob, state).unspent.map((n) => n.assetId), [4]);
  const listings = await api('GET', '/listings');
  assert.equal(listings.length, 1);
  assert.equal(listings[0].inscriptionId, kids[2].id);
  ok(`batch ${flushed.txid.slice(0, 16)}… carried the send + the listing; Bob holds piece 4; piece 5 listed at 70,000`);

  step('buy over HTTP: Bob buys piece 5');
  const listing = state.listings.find((l) => l.state === 'ACTIVE');
  const fundB = await payerCoin(150_000);
  await rt.mine();
  const buy = buildBuy({ rulesInscriptionId: PARENT_ID, vault: bob, listing });
  const bp = buyPsbt({ rules: R, network: NET, listing, buy, funding: [fundB], changeScript: payer.output, feeRate: 2 }).psbt;
  signPayer(bp);
  const bs = bitcoin.Psbt.fromBase64((await api('POST', '/sign', { psbt: bp.toBase64() })).psbt, { network: NET });
  bs.finalizeAllInputs();
  const { txid: buyTxid } = await api('POST', '/broadcast', { hex: bs.extractTransaction().toHex() });
  const paidOut = (await rt.node('getrawtransaction', buyTxid, true)).vout.find((o) => o.scriptPubKey.hex === sellerScript.toString('hex'));
  assert.equal(Math.round(paidOut.value * 1e8), 70_000);
  await rt.mine();
  state = await api('GET', '/state');
  assert.deepEqual(scanState(bob, state).unspent.map((n) => n.assetId).sort(), [4, 5]);
  ok('Bob holds pieces 4 and 5; Alice\'s payout key was paid');

  step('cancel over HTTP: Bob lists piece 4, then cancels; the platform pays the fee');
  const b4 = scanState(bob, state).unspent.find((n) => n.assetId === 4);
  const l4 = await buildList({ rulesInscriptionId: PARENT_ID, vault: bob, note: b4, price: 1_000_000, sellerScript: artist.output, state, zk, spend: 0, buy: 0 });
  await assert.rejects(api('POST', '/relay', { envelopeHex: l4.data.toString('hex') }), /spend one ticket/);
  const l4r = await buildList({ rulesInscriptionId: PARENT_ID, vault: bob, note: b4, price: 1_000_000, sellerScript: artist.output, state, zk });
  await api('POST', '/relay', { envelopeHex: l4r.data.toString('hex') });
  await platform.tasks.relay();
  await rt.mine();
  state = await api('GET', '/state');
  const active = state.listings.find((l) => l.state === 'ACTIVE');
  const claim = buildClaim({ rulesInscriptionId: PARENT_ID, vault: bob, listing: active });
  const { txid: cancelTxid } = await api('POST', '/cancel', { claimHex: claim.data.toString('hex') });
  await rt.mine();
  state = await api('GET', '/state');
  assert.equal(state.listings.find((l) => l.nf === active.nf).state, 'CLAIMED');
  assert.deepEqual(scanState(bob, state).unspent.map((n) => n.assetId).sort(), [4, 5]);
  ok(`cancelled in ${cancelTxid.slice(0, 16)}…; piece 4 is back in Bob's vault`);

  const final = await api('GET', '/status');
  ok(`final: block ${final.lastHeight}, ${final.notes} notes, digest ${final.digest.slice(0, 16)}…, ${final.inscribed} inscribed`);
  console.log('\nALL PLATFORM CHECKS PASSED');
} finally {
  await platform?.close();
  await shutdownProver();
  rt.stop();
}
