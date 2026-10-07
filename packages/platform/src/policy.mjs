// The platform signer for a single-key collection (rules.gateKey / rules.lockKey): the role Ord Dropz
// plays for Shielded Nakas. It signs exactly one input of a PSBT someone else built, and only when
// its OWN indexer says the transaction is valid right now:
//
//   gate coin  the tx carries one paid MINT / MINTN that would be accepted, every piece unminted and
//              not in another mint this signer already approved, and it returns the gate coin's value
//              to the gate address (the pool of gate coins never shrinks).
//   lock       the tx carries a valid BUY of that listing, or the seller's own signed CLAIM (cancel),
//              and no other pending tx this signer approved spends the same lock.
//
// Same rules as the vendor's 2-of-3 co-signer (cosign.mjs cosignPolicy), on the key path. The
// signature is SIGHASH_DEFAULT, so it commits to every input and output: nobody can change the tx
// afterwards. The signer never holds a piece or the buyer's coins.
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { gateScript, lockScript, lockLeaf } from '../../sdk/src/scripts-compat.mjs';
import { tapleafHash, CosignMemory } from '../../../vendor/shielded-ordinals/src/v1/cosign.mjs';
import { outpointKey } from '../../../vendor/shielded-ordinals/src/v1/indexer.mjs';
import { keyPathSigner, xonlyOfPriv } from '../../sdk/src/signers.mjs';

export { keyPathSigner, xonlyOfPriv };

bitcoin.initEccLib(ecc);


/** The PSBT as the indexer sees a tx: txid (witness-free, so known before signing), ins, outs. */
export function indexerTxOf(psbt) {
  const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  return {
    txid: tx.getId(),
    ins: tx.ins.map((i, n) => ({ txid: Buffer.from(i.hash).reverse().toString('hex'), vout: i.index, script: Buffer.from(psbt.data.inputs[n].witnessUtxo.script) })),
    outs: tx.outs.map((o) => ({ script: Buffer.from(o.script), value: o.value })),
  };
}

export class PlatformSigner {
  constructor({ rules, network, gatePriv, lockPriv }) {
    if (rules.cosigners) throw new Error('this collection uses co-signers: run vendor/cosigner instead');
    if (xonlyOfPriv(gatePriv) !== rules.gateKey) throw new Error('gate key does not match rules.gateKey');
    if (xonlyOfPriv(lockPriv) !== rules.lockKey) throw new Error('lock key does not match rules.lockKey');
    Object.assign(this, { rules, network, gatePriv, lockPriv });
    this.gate = gateScript(rules, network);
    this.memory = new CosignMemory();
  }

  /** Check, then sign the one platform input. Returns { ok, reason?, kind, index, psbt, txid }. */
  async review(ix, psbt) {
    const itx = indexerTxOf(psbt);
    this.memory.prune(ix);
    const gates = itx.ins.map((i, n) => (i.script.equals(this.gate) ? n : -1)).filter((n) => n >= 0);
    const locks = itx.ins.map((i, n) => (ix.lockIndex.has(outpointKey(i.txid, i.vout)) ? n : -1)).filter((n) => n >= 0);
    if (gates.length + locks.length !== 1) return { ok: false, reason: 'a tx gets exactly one platform signature' };
    const r = await ix.wouldAccept(itx);

    if (gates.length) {
      const index = gates[0];
      const mints = r.envelopes.filter((e) => e.type === 'MINT' || e.type === 'MINTN');
      if (r.paid !== 1 || mints.length !== 1) return { ok: false, reason: 'a gate coin approves exactly one mint' };
      const m = mints[0];
      if (!m.ok) return { ok: false, reason: 'mint would be rejected: ' + m.reason };
      if (m.info.skipped?.length) return { ok: false, reason: `already minted: ${m.info.skipped.join(',')}` };
      const busy = m.info.assetIds.filter((a) => this.memory.pieces.has(a) && this.memory.pieces.get(a).txid !== itx.txid);
      if (busy.length) return { ok: false, reason: `pieces ${busy.join(',')} are in another pending mint` };
      const gateValue = psbt.data.inputs[index].witnessUtxo.value;
      const returned = itx.outs.filter((o) => o.script.equals(this.gate)).reduce((s, o) => s + o.value, 0);
      if (returned < gateValue) return { ok: false, reason: 'the gate coin must be returned to the gate address' };
      psbt.signInput(index, keyPathSigner(this.gatePriv));
      for (const a of m.info.assetIds) this.memory.pieces.set(a, { txid: itx.txid, at: Date.now() });
      return { ok: true, kind: 'mint', index, psbt, txid: itx.txid, assetIds: m.info.assetIds };
    }

    const index = locks[0];
    const key = outpointKey(itx.ins[index].txid, itx.ins[index].vout);
    const nf = ix.lockIndex.get(key);
    const l = ix.listings.get(nf);
    if (!itx.ins[index].script.equals(lockScript(this.rules, l.returnKey, this.network))) return { ok: false, reason: 'lock script mismatch' };
    const buy = r.envelopes.find((e) => e.type === 'BUY' && e.ok && e.info.listingNf === nf);
    const claim = r.envelopes.find((e) => e.type === 'CLAIM' && e.ok && e.info.listingNf === nf);
    if (!buy && !claim) {
      const why = r.envelopes.find((e) => (e.type === 'BUY' || e.type === 'CLAIM') && !e.ok);
      return { ok: false, reason: why ? `${why.type} would be rejected: ${why.reason}` : 'a lock is only spent by a valid buy or the seller\'s cancel' };
    }
    if (buy && r.paid !== 1) return { ok: false, reason: 'a buy must be the only paid envelope' };
    const prev = this.memory.locks.get(key);
    if (prev && prev.txid !== itx.txid) return { ok: false, reason: 'this listing is already being bought or cancelled' };
    psbt.signInput(index, keyPathSigner(this.lockPriv, tapleafHash(lockLeaf(l.returnKey))));
    this.memory.locks.set(key, { txid: itx.txid, at: Date.now() });
    return { ok: true, kind: buy ? 'buy' : 'cancel', index, psbt, txid: itx.txid, listing: l };
  }

  /** A mint or sale that never confirmed (e.g. the buyer double-spent their own coin) frees its pieces. */
  forget(txid) { this.memory.forgetTx(txid); }
}
