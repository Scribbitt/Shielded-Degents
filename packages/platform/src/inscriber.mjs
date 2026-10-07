// File-mint inscriber: after a piece is minted, inscribe its file as a true child of the collection
// parent (ord tag 3), parked at NUMS so the art sat can never move. Paid for by the inscribeFee every
// mint sends to the relayer payout (this hot wallet).
//
// One batch = commit (hot wallet -> commit address) + reveal [parent, commit] -> [parent return,
// child 0 .. child n-1]. The parent is carried from batch to batch; its current outpoint is persisted.
// Anyone can check a child is piece N: sha256(file) + the art Merkle path against rules.artRoot.
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'buffer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { planInscriptions, revealTx, revealVsize, childItems, numsScript } from '../../sdk/src/inscribe.mjs';
import { fileHash } from '../../../vendor/shielded-ordinals/src/v1/art.mjs';

export const POSTAGE = 546;
export const MAX_BATCH = 20;

/**
 * artDir holds <assetId>.<ext> files in the order artRoot commits to (tools/prepare-art.mjs output).
 * store: { get(), set(patch) } persisted platform state with { parent: {txid,vout,value}, inscribed: {assetId: inscriptionId} }.
 */
export function inscriber({ network, networkName, rules, rulesInscriptionId, artDir, wallet, io, store, expectedHashes }) {
  const files = new Map(fs.readdirSync(artDir).filter((f) => /^\d+\.[a-z0-9]+$/i.test(f)).map((f) => [Number(f.split('.')[0]), path.join(artDir, f)]));

  function pending(ix) {
    const done = store.get().inscribed ?? {};
    return [...ix.minted.keys()].filter((a) => done[a] === undefined).sort((a, b) => a - b).slice(0, MAX_BATCH);
  }

  async function runOnce(ix) {
    const ids = pending(ix);
    if (!ids.length) return null;
    const parent = store.get().parent;
    if (!parent) throw new Error('no parent outpoint configured (PARENT_OUTPOINT)');
    const items = childItems({
      parentId: rulesInscriptionId, parentValue: parent.value, postage: POSTAGE,
      files: ids.map((id) => {
        const f = files.get(id);
        if (!f) throw new Error(`art for piece ${id} is missing from ${artDir}`);
        const body = fs.readFileSync(f);
        if (expectedHashes && !fileHash(body).equals(Buffer.from(expectedHashes[id]))) throw new Error(`art for piece ${id} does not match the art root`);
        return { contentType: rules.contentType, body };
      }),
    });
    const revealPriv = schnorr.utils.randomSecretKey();
    const plan = planInscriptions({ network: networkName, revealPriv, items });
    const feeRate = await io.feeRate();
    const outputs = [{ script: wallet.script, value: parent.value }, ...ids.map(() => ({ script: numsScript(networkName), value: POSTAGE }))];
    const parentIn = { ...parent, priv: Buffer.from(wallet.priv, 'hex') };
    const vsize = revealVsize({ network: networkName, plan, revealPriv, commit: { txid: '00'.repeat(32), vout: 0, value: 1_000_000 }, parent: parentIn, outputs });
    const commitValue = ids.length * POSTAGE + Math.ceil((vsize + 10) * feeRate);
    const commit = await wallet.pay({ outputs: [{ script: plan.commitScript, value: commitValue }], feeRate, exclude: [`${parent.txid}:${parent.vout}`] });
    const reveal = revealTx({ network: networkName, plan, revealPriv, commit: { txid: commit.txid, vout: 0, value: commitValue }, parent: parentIn, outputs });
    await io.broadcast(commit.hex);
    await io.broadcast(reveal.hex);
    const inscribed = { ...(store.get().inscribed ?? {}) };
    ids.forEach((id, k) => { inscribed[id] = `${reveal.txid}i${k}`; });
    wallet.protected.delete(`${parent.txid}:${parent.vout}`);
    wallet.protected.add(`${reveal.txid}:0`);
    store.set({ parent: { txid: reveal.txid, vout: 0, value: parent.value }, inscribed });
    return { ids, commitTxid: commit.txid, revealTxid: reveal.txid };
  }

  return { pending, runOnce };
}
