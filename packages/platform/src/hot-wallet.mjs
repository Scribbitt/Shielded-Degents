// The platform's hot wallet: one key-path P2TR key. It is the relayer payout in the rules (relay
// tickets and inscribe fees are paid here), so it funds what it publishes: relay batches, cancels,
// child inscriptions, gate coins. It also holds the collection parent until the last child.
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { fundPsbt } from '../../sdk/src/txs.mjs';
import { keyPathSigner, xonlyOfPriv } from '../../sdk/src/signers.mjs';

export class HotWallet {
  constructor({ priv, network, io }) {
    this.priv = priv;
    this.network = network;
    this.io = io;
    this.xonly = Buffer.from(xonlyOfPriv(priv), 'hex');
    const pay = bitcoin.payments.p2tr({ internalPubkey: this.xonly, network });
    this.script = pay.output;
    this.address = pay.address;
    this.reserved = new Set(); // outpoints promised to a tx not yet seen by the node
    this.protected = new Set(); // never spent as a fee coin (the collection parent)
  }

  async coins({ exclude = [] } = {}) {
    const skip = new Set([...exclude, ...this.reserved, ...this.protected]);
    return (await this.io.utxos(this.address))
      .filter((u) => !skip.has(`${u.txid}:${u.vout}`))
      .map((u) => ({ ...u, script: this.script, tapInternalKey: this.xonly }));
  }

  /** Sign every input this wallet owns (key path, no script tree). */
  signOwn(psbt) {
    psbt.data.inputs.forEach((inp, i) => {
      if (inp.witnessUtxo && Buffer.from(inp.witnessUtxo.script).equals(this.script) && !inp.tapKeySig) psbt.signInput(i, keyPathSigner(this.priv));
    });
  }

  /** Pay `outputs` from this wallet. Returns { hex, txid, psbt } without broadcasting. */
  async pay({ outputs, feeRate, exclude = [] }) {
    const psbt = new bitcoin.Psbt({ network: this.network });
    const funding = (await this.coins({ exclude })).filter((c) => c.value > 0);
    const r = fundPsbt(psbt, { fixedIns: [], outputs, funding, changeScript: this.script, feeRate });
    this.signOwn(r.psbt);
    r.psbt.finalizeAllInputs();
    const tx = r.psbt.extractTransaction();
    for (const i of tx.ins) this.reserved.add(`${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`);
    return { hex: tx.toHex(), txid: tx.getId(), psbt: r.psbt };
  }

  /** The node has seen (or dropped) everything we reserved: start from its view again. */
  release() { this.reserved.clear(); }
}
