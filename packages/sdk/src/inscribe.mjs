// Ordinal inscriptions for launch and the post-mint inscriber (Node / backend: @scure/btc-signer +
// micro-ordinals; the vendor reads them back with inscribe.mjs readInscriptions).
//
//   planInscriptions   the commit address for one reveal that carries 1..n envelopes
//   revealTx           the signed reveal: optional parent input first (ord parent rule), then the
//                      commit input; each envelope gets a pointer so piece k lands on its own output
//
// Layout of a reveal with a parent:  in [parent, commit]  ->  out [parent return, child 0 .. child n-1, change?]
// ord puts each new inscription at its pointer (an offset into the outputs), so child k sits on the
// first sat of output 1 + k.
import { Buffer } from 'buffer';
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';

const customScripts = [ordinals.OutOrdinalReveal];
export const NETWORKS = {
  mainnet: btc.NETWORK,
  signet: btc.TEST_NETWORK,
  testnet: btc.TEST_NETWORK,
  regtest: { ...btc.TEST_NETWORK, bech32: 'bcrt' },
};
// BIP341 NUMS point: art sats parked here can never move again
export const NUMS_HEX = '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0';
export const numsScript = (network = 'mainnet') => Buffer.from(btc.p2tr(hex.decode(NUMS_HEX), undefined, NETWORKS[network]).script);

/** items: [{ contentType, body, parent?, metadata?, pointer? }] */
export function planInscriptions({ network, revealPriv, items }) {
  const pub = schnorr.getPublicKey(revealPriv);
  const inscriptions = items.map((it) => ({
    tags: {
      contentType: it.contentType,
      ...(it.parent ? { parent: it.parent } : {}),
      ...(it.pointer !== undefined ? { pointer: BigInt(it.pointer) } : {}),
      ...(it.metadata ? { metadata: it.metadata } : {}),
    },
    body: Buffer.from(it.body),
  }));
  const payment = btc.p2tr(undefined, ordinals.p2tr_ord_reveal(pub, inscriptions), NETWORKS[network], false, customScripts);
  return { payment, commitAddress: payment.address, commitScript: Buffer.from(payment.script), count: items.length };
}

/**
 * commit: { txid, vout, value }; parent: { txid, vout, value, priv } (a key-path P2TR coin) or null.
 * outputs: [{ script, value }] in order (parent return first when there is a parent).
 * Fee: whatever commit (+ parent) value the outputs leave.
 */
export function revealTx({ network, plan, revealPriv, commit, parent = null, outputs }) {
  const tx = new btc.Transaction({ customScripts, allowUnknownOutputs: true });
  if (parent) {
    const pPub = schnorr.getPublicKey(parent.priv);
    const pPay = btc.p2tr(pPub, undefined, NETWORKS[network]);
    tx.addInput({ txid: parent.txid, index: parent.vout, witnessUtxo: { script: pPay.script, amount: BigInt(parent.value) }, tapInternalKey: pPay.tapInternalKey });
  }
  tx.addInput({ ...plan.payment, txid: commit.txid, index: commit.vout, witnessUtxo: { script: plan.payment.script, amount: BigInt(commit.value) } });
  for (const o of outputs) tx.addOutput({ script: Buffer.from(o.script), amount: BigInt(o.value) });
  if (parent) tx.signIdx(parent.priv, 0);
  tx.signIdx(revealPriv, parent ? 1 : 0);
  tx.finalize();
  return { hex: hex.encode(tx.extract()), txid: tx.id, vsize: tx.vsize };
}

/** Child inscription items for a reveal with a parent, pointing piece k at output 1 + k. */
export function childItems({ parentId, parentValue, postage, files }) {
  return files.map((f, k) => ({ contentType: f.contentType, body: f.body, parent: parentId, pointer: parentValue + k * postage, metadata: f.metadata }));
}

/** Exact reveal vsize for fee planning: a dry run signed with the real keys and zero fee. */
export function revealVsize(args) {
  const total = args.commit.value + (args.parent?.value ?? 0);
  const outs = args.outputs.length ? args.outputs : [{ script: numsScript(args.network), value: total }];
  return revealTx({ ...args, outputs: outs }).vsize;
}
