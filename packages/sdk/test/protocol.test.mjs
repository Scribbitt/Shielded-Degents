// Offline: every SDK-built envelope is judged by the UNMODIFIED vendor indexer (the same code anyone
// runs against Bitcoin). Blocks are synthetic; scripts and payouts are real.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Indexer } from '../../../vendor/shielded-ordinals/src/v1/indexer.mjs';
import { parseRules, saleFee } from '../../../vendor/shielded-ordinals/src/v1/rules.mjs';
import { gateScript, lockScript } from '../../../vendor/shielded-ordinals/src/v1/scripts.mjs';
import { exportState } from '../../../vendor/shielded-ordinals/src/v1/view.mjs';
import { newSeed, vaultFromSeed, decodeAddress, payoutKeyFor } from '../src/keys.mjs';
import { scanState, encryptNote, decryptNote, randomField } from '../src/notes.mjs';
import { buildMint, buildTransfer, buildList, buildBuy, buildClaim, shutdownProver } from '../src/actions.mjs';
after(shutdownProver);

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const zk = { wasm: ROOT + 'vendor/shielded-ordinals/build/spend_js/spend.wasm', zkey: ROOT + 'zk/dev-ceremony/spend/final.zkey' };
const vkey = JSON.parse(fs.readFileSync(ROOT + 'zk/dev-ceremony/spend/vkey.json', 'utf8'));
const NET = bitcoin.networks.regtest;

const p2tr = () => Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))]);
const xonly = () => Buffer.from(schnorr.getPublicKey(schnorr.utils.randomSecretKey())).toString('hex');
const ARTIST = p2tr(); const PLATFORM = p2tr(); const RELAYER = p2tr();
const PARENT = 'ab'.repeat(32) + 'i0';
const rules = parseRules({
  p: 'shord', v: 1, name: 'Shielded Degents (test)', supply: 8, artRoot: 'cd'.repeat(32), contentType: 'image/png',
  inscribeFee: 3000, relayerPayoutScript: RELAYER.toString('hex'), mintPrice: 50000, artistPayoutScript: ARTIST.toString('hex'),
  platformPayoutScript: PLATFORM.toString('hex'), mintFee: 3500, saleFeeBps: 250, saleFeeMin: 1000, ticketPrice: 1500,
  gateKey: xonly(), lockKey: xonly(), spendVkeyHash: (await import('../../../vendor/shielded-ordinals/src/v1/rules.mjs')).vkeyHash(vkey),
});
const opret = (data) => bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data]);
let n = 0;
const txid = () => (++n).toString(16).padStart(64, '0');
const lastOk = (ix) => { const l = ix.log.at(-1); assert.ok(l.accepted, `rejected: ${l.reason}`); return l; };

test('address and note encryption round-trip', () => {
  const v = vaultFromSeed(newSeed());
  assert.equal(decodeAddress(v.address).pk, v.pk);
  const note = { assetId: 7, tickets: 3, rho: randomField(), s: randomField() };
  const { epk, ct } = encryptNote(v.viewPk, note);
  assert.deepEqual(decryptNote(v, epk, ct), note);
  assert.equal(decryptNote(vaultFromSeed(newSeed()), epk, ct), null);
});

test('mint -> private send -> list -> buy, and list -> cancel -> claim, all accepted by the reference indexer', { timeout: 120_000 }, async () => {
  const alice = vaultFromSeed(newSeed());
  const bob = vaultFromSeed(newSeed());
  const ix = new Indexer({ rulesInscriptionId: PARENT, rules, network: NET, vkey });
  let h = 100;
  const block = (...txs) => ix.applyBlock(h++, txs);
  const state = () => exportState(ix);
  await block();

  // MINTN: Alice mints pieces 2 and 5 with 2 relay tickets each
  const mint = buildMint({ rulesInscriptionId: PARENT, vault: alice, assetIds: [2, 5], ticketsBuy: 2 });
  await block({
    txid: txid(), ins: [{ txid: txid(), vout: 0, script: gateScript(rules, NET) }],
    outs: [{ script: opret(mint.data), value: 0 }, { script: ARTIST, value: 100000 }, { script: PLATFORM, value: 7000 },
      { script: RELAYER, value: 2 * 3000 + 4 * 1500 }],
  });
  lastOk(ix);
  let mine = scanState(alice, state());
  assert.deepEqual(mine.unspent.map((x) => x.assetId).sort(), [2, 5]);

  // TRANSFER (relayed, spends 1 ticket): Alice -> Bob, piece 2
  const piece2 = mine.unspent.find((x) => x.assetId === 2);
  const send = await buildTransfer({ rulesInscriptionId: PARENT, vault: alice, note: piece2, to: bob.address, state: state(), zk });
  await block({ txid: txid(), ins: [{ txid: txid(), vout: 0 }], outs: [{ script: opret(send.data), value: 0 }] });
  lastOk(ix);
  const bobs = scanState(bob, state());
  assert.equal(bobs.unspent.length, 1);
  assert.equal(bobs.unspent[0].assetId, 2);
  assert.equal(bobs.unspent[0].tickets, 1);
  assert.equal(bobs.unspent[0].s, piece2.s, 'piece secret is conserved across a private send');
  assert.ok(scanState(alice, state()).notes.find((x) => x.assetId === 2).spent);

  // the same note can't be spent twice
  const again = await buildTransfer({ rulesInscriptionId: PARENT, vault: alice, note: piece2, to: bob.address, state: state(), zk });
  await block({ txid: txid(), ins: [{ txid: txid(), vout: 0 }], outs: [{ script: opret(again.data), value: 0 }] });
  assert.match(ix.log.at(-1).reason, /double spend/);

  // LIST (relayed): Bob lists piece 2 for 40,000 sats, paid to a fresh payout key
  const bobNote = scanState(bob, state()).unspent[0];
  const payout = payoutKeyFor(bob, bobNote.nf);
  const sellerScript = Buffer.concat([Buffer.from([0x51, 0x20]), payout.xonly]);
  const list = await buildList({ rulesInscriptionId: PARENT, vault: bob, note: bobNote, price: 40000, sellerScript, state: state(), zk });
  const listTx = txid();
  await block({ txid: listTx, ins: [{ txid: txid(), vout: 0 }],
    outs: [{ script: opret(list.data), value: 0 }, { script: lockScript(rules, list.returnKey, NET), value: 330 }] });
  lastOk(ix);
  const listing = scanState(bob, state()).listings[0];
  assert.equal(listing.state, 'ACTIVE');
  assert.equal(listing.tickets, 0);

  // BUY: Alice buys it, topping up 1 ticket
  const buy = buildBuy({ rulesInscriptionId: PARENT, vault: alice, listing, ticketsBuy: 1 });
  await block({ txid: txid(), ins: [{ txid: listTx, vout: 1 }],
    outs: [{ script: opret(buy.data), value: 0 }, { script: sellerScript, value: 40000 },
      { script: PLATFORM, value: Number(saleFee(rules, 40000n)) }, { script: RELAYER, value: 1500 }] });
  lastOk(ix);
  mine = scanState(alice, state());
  assert.deepEqual(mine.unspent.map((x) => x.assetId).sort(), [2, 5]);
  assert.notEqual(mine.unspent.find((x) => x.assetId === 2).s, piece2.s, 'a sale gives the piece a new secret');

  // LIST then cancel (lock spent with no BUY) then CLAIM back: piece 5, self-published (spend 0)
  const p5 = mine.unspent.find((x) => x.assetId === 5);
  const list5 = await buildList({ rulesInscriptionId: PARENT, vault: alice, note: p5, price: 90000, sellerScript: ARTIST, state: state(), zk, spend: 0 });
  const list5Tx = txid();
  await block({ txid: list5Tx, ins: [{ txid: txid(), vout: 0 }],
    outs: [{ script: opret(list5.data), value: 0 }, { script: lockScript(rules, list5.returnKey, NET), value: 330 }] });
  lastOk(ix);
  const l5 = scanState(alice, state()).listings.find((l) => l.assetId === 5);
  const claim = buildClaim({ rulesInscriptionId: PARENT, vault: alice, listing: l5 });
  await block({ txid: txid(), ins: [{ txid: list5Tx, vout: 1 }], outs: [{ script: opret(claim.data), value: 0 }] });
  lastOk(ix);
  mine = scanState(alice, state());
  assert.deepEqual(mine.unspent.map((x) => x.assetId).sort(), [2, 5]);
  assert.equal(mine.unspent.find((x) => x.assetId === 5).tickets, 2);

  // a stranger can't claim someone else's listing
  assert.throws(() => buildClaim({ rulesInscriptionId: PARENT, vault: bob, listing: l5 }), /not made by this vault/);
});
