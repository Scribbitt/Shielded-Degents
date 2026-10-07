// Carrier transactions for every action, as unsigned PSBTs.
//
// The user's wallet signs its own coins (`funding`); the platform signs the gate coin (mint) or the
// listing lock (buy, cancel) after its own indexer checks the transaction (packages/platform).
// Every payout is an explicit output, so the indexer's "summed per scriptPubKey" check passes
// whatever the artist / platform / relayer scripts are.
//
//   funding: [{ txid, vout, value, script, tapInternalKey?, redeemScript? }]   the payer's coins
//            (P2TR, P2WPKH, or P2SH-P2WPKH with its redeemScript)
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { saleFee, dustFor } from '../../../vendor/shielded-ordinals/src/v1/rules.mjs';
import { gateScript, lockScript, lockLeaf, LOCK_ESCAPE_CSV_EXPORT } from './scripts-compat.mjs';
import { tapleafHash } from '../../../vendor/shielded-ordinals/src/v1/cosign.mjs';
import { p2trScriptOf } from './signers.mjs';

bitcoin.initEccLib(ecc);

export const LOCK_VALUE = 330; // same as the reference relayer
const RBF = 0xfffffffd;

export const opReturn = (data) => bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, Buffer.from(data)]);

// vbytes per input by the script it spends (key-path taproot, P2WPKH, script-path escape leaf)
function inputVbytes(script, kind) {
  if (kind === 'escape') return 41 + (1 + 65 + 1 + 39 + 1 + 65) / 4; // sig + leaf + control block
  if (script[0] === 0x51 && script.length === 34) return 57.5;
  if (script[0] === 0x00 && script.length === 22) return 68;
  return 91; // conservative for anything else
}
const outputVbytes = (script) => 8 + 1 + script.length + (script.length >= 0xfd ? 2 : 0);

/**
 * Add the payer's coins, size the fee from the final shape and add change.
 * fixedIns: inputs already on the PSBT (gate, lock) as [{ script, value, kind? }].
 */
export function fundPsbt(psbt, { fixedIns, outputs, funding, changeScript, feeRate }) {
  const outVal = outputs.reduce((s, o) => s + o.value, 0);
  const fixedVal = fixedIns.reduce((s, i) => s + i.value, 0);
  const used = [];
  let vbytes = 10.5 + outputs.reduce((s, o) => s + outputVbytes(o.script), 0) + outputVbytes(changeScript)
    + fixedIns.reduce((s, i) => s + inputVbytes(i.script, i.kind), 0);
  // largest coins first: fewer inputs, smaller tx
  for (const c of [...funding].sort((a, b) => b.value - a.value)) {
    const fee = Math.ceil(vbytes * feeRate);
    const have = fixedVal + used.reduce((s, u) => s + u.value, 0);
    if (have >= outVal + fee + dustFor(changeScript) || (used.length && have >= outVal + fee && have - outVal - fee < dustFor(changeScript))) break;
    used.push(c);
    vbytes += inputVbytes(Buffer.from(c.script));
  }
  const fee = Math.ceil(vbytes * feeRate);
  const have = fixedVal + used.reduce((s, u) => s + u.value, 0);
  const change = have - outVal - fee;
  if (change < 0) throw new Error(`not enough bitcoin: short by ${-change} sats`);
  for (const c of used) {
    psbt.addInput({
      hash: c.txid, index: c.vout, sequence: RBF, witnessUtxo: { script: Buffer.from(c.script), value: c.value },
      ...(c.tapInternalKey ? { tapInternalKey: Buffer.from(c.tapInternalKey) } : {}),
      ...(c.redeemScript ? { redeemScript: Buffer.from(c.redeemScript) } : {}),
    });
  }
  for (const o of outputs) psbt.addOutput({ script: o.script, value: o.value });
  const withChange = change >= dustFor(changeScript);
  if (withChange) psbt.addOutput({ script: Buffer.from(changeScript), value: change });
  return { psbt, fee: withChange ? fee : fee + change, vbytes: Math.ceil(vbytes), fundingInputs: used.length };
}

/**
 * MINT / MINTN. Input 0 is a platform gate coin, which is returned to the gate address in the
 * last fixed output so the platform's pool of gate coins never shrinks.
 */
export function mintPsbt({ rules, network, gate, mint, count, funding, changeScript, feeRate }) {
  const psbt = new bitcoin.Psbt({ network });
  const gScript = gateScript(rules, network);
  psbt.addInput({ hash: gate.txid, index: gate.vout, sequence: RBF, witnessUtxo: { script: gScript, value: gate.value }, tapInternalKey: Buffer.from(rules.gateKey, 'hex') });
  const n = count;
  const outputs = [
    { script: opReturn(mint.data), value: 0 },
    { script: rules.artistScript, value: n * rules.mintPrice },
    ...(rules.mintFee > 0 ? [{ script: rules.platformScript, value: n * rules.mintFee }] : []),
    ...(n * rules.inscribeFee + mint.tickets * rules.ticketPrice > 0
      ? [{ script: rules.relayerScript, value: n * rules.inscribeFee + mint.tickets * rules.ticketPrice }] : []),
    { script: gScript, value: gate.value },
  ];
  return fundPsbt(psbt, { fixedIns: [{ script: gScript, value: gate.value }], outputs, funding, changeScript, feeRate });
}

/** BUY. Input 0 is the listing lock (co-signed by the platform key path). */
export function buyPsbt({ rules, network, listing, buy, ticketsBuy = 0, funding, changeScript, feeRate }) {
  const psbt = new bitcoin.Psbt({ network });
  const returnKey = Buffer.from(listing.returnKey, 'hex');
  const lScript = lockScript(rules, returnKey, network);
  psbt.addInput({
    hash: listing.lock.txid, index: listing.lock.vout, sequence: RBF, witnessUtxo: { script: lScript, value: listing.lock.value },
    tapInternalKey: Buffer.from(rules.lockKey, 'hex'), tapMerkleRoot: tapleafHash(lockLeaf(returnKey)),
  });
  const outputs = [
    { script: opReturn(buy.data), value: 0 },
    { script: Buffer.from(listing.sellerScript, 'hex'), value: Number(listing.price) },
    { script: rules.platformScript, value: Number(saleFee(rules, BigInt(listing.price))) },
    ...(ticketsBuy > 0 ? [{ script: rules.relayerScript, value: ticketsBuy * rules.ticketPrice }] : []),
  ];
  return fundPsbt(psbt, { fixedIns: [{ script: lScript, value: listing.lock.value }], outputs, funding, changeScript, feeRate });
}

/**
 * Self-published TRANSFER / LIST / CLAIM (spend = 0): the user's own wallet pays the miner.
 * A LIST also creates its lock; a top-up (`buy` > 0) pays buy x ticketPrice to the relayer.
 */
export function selfPublishPsbt({ rules, network, data, lockFor, buy = 0, funding, changeScript, feeRate }) {
  const psbt = new bitcoin.Psbt({ network });
  const outputs = [
    { script: opReturn(data), value: 0 },
    ...(lockFor ? [{ script: lockScript(rules, Buffer.from(lockFor), network), value: LOCK_VALUE }] : []),
    ...(buy > 0 ? [{ script: rules.relayerScript, value: buy * rules.ticketPrice }] : []),
  ];
  return fundPsbt(psbt, { fixedIns: [], outputs, funding, changeScript, feeRate });
}

/**
 * The seller's escape hatch: after LOCK_ESCAPE_CSV blocks, spend the lock through the escape leaf
 * with the listing's return key, with the CLAIM in the same tx. Needs nobody else.
 */
export function escapePsbt({ rules, network, listing, claim, funding, changeScript, feeRate }) {
  const psbt = new bitcoin.Psbt({ network });
  const returnKey = Buffer.from(listing.returnKey, 'hex');
  const leaf = lockLeaf(returnKey);
  const pay = bitcoin.payments.p2tr({ internalPubkey: Buffer.from(rules.lockKey, 'hex'), scriptTree: { output: leaf }, redeem: { output: leaf, redeemVersion: 0xc0 }, network });
  psbt.addInput({
    hash: listing.lock.txid, index: listing.lock.vout, sequence: LOCK_ESCAPE_CSV_EXPORT,
    witnessUtxo: { script: pay.output, value: listing.lock.value },
    tapLeafScript: [{ leafVersion: 0xc0, script: leaf, controlBlock: pay.witness[pay.witness.length - 1] }],
  });
  const outputs = [{ script: opReturn(claim.data), value: 0 }];
  return fundPsbt(psbt, { fixedIns: [{ script: pay.output, value: listing.lock.value, kind: 'escape' }], outputs, funding, changeScript, feeRate });
}

/** Unsigned tx + every prevout, the shape the platform signer and the indexer check. */
export function psbtPrevouts(psbt) {
  return psbt.data.inputs.map((i) => ({ script: Buffer.from(i.witnessUtxo.script), value: i.witnessUtxo.value }));
}

/**
 * Cancel: [lock, platform coin] -> [CLAIM, change]. The seller signs the CLAIM (return key); the
 * platform co-signs the lock key path and pays the miner from its own coin.
 */
export function cancelPsbt({ rules, network, listing, claim, funding, changeScript, feeRate }) {
  const psbt = new bitcoin.Psbt({ network });
  const returnKey = Buffer.from(listing.returnKey, 'hex');
  const lScript = lockScript(rules, returnKey, network);
  psbt.addInput({
    hash: listing.lock.txid, index: listing.lock.vout, sequence: RBF, witnessUtxo: { script: lScript, value: listing.lock.value },
    tapInternalKey: Buffer.from(rules.lockKey, 'hex'), tapMerkleRoot: tapleafHash(lockLeaf(returnKey)),
  });
  const outputs = [{ script: opReturn(claim.data), value: 0 }];
  return fundPsbt(psbt, { fixedIns: [{ script: lScript, value: listing.lock.value }], outputs, funding, changeScript, feeRate });
}

/**
 * Sweep sale proceeds: each coin sits on a fresh payout key the vault derived for that listing.
 * coins: [{ txid, vout, value, xonly }]. Signed by the caller with keyPathSigner(payoutKey.priv).
 */
export function sweepPsbt({ network, coins, to, feeRate }) {
  const psbt = new bitcoin.Psbt({ network });
  for (const c of coins) {
    const script = p2trScriptOf(c.xonly);
    psbt.addInput({ hash: c.txid, index: c.vout, sequence: RBF, witnessUtxo: { script, value: c.value }, tapInternalKey: Buffer.from(c.xonly) });
  }
  const total = coins.reduce((s, c) => s + c.value, 0);
  const fee = Math.ceil((10.5 + coins.length * 57.5 + outputVbytes(Buffer.from(to))) * feeRate);
  if (total - fee < dustFor(Buffer.from(to))) throw new Error('proceeds are too small to sweep at this fee rate');
  psbt.addOutput({ script: Buffer.from(to), value: total - fee });
  return { psbt, fee };
}
