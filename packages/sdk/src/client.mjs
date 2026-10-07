// The Shielded Degents client: every user action against a platform service, with no UI.
// The web app is a thin layer over this; tests drive it headless on regtest.
//
// A payer is the user's bitcoin wallet (Unisat, Xverse, a dev key, ...):
//   { address, script, coins(): [{ txid, vout, value, script, tapInternalKey?, redeemScript? }],
//     signPsbt(psbt, indexes): Promise<Psbt> }   signs only the inputs listed, does not finalize
// The vault (keys.mjs) never leaves the device; the platform only ever sees envelopes and PSBTs.
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { parseRules } from '../../../vendor/shielded-ordinals/src/v1/rules.mjs';
import { scanState } from './notes.mjs';
import { payoutKeyFor, returnKeyFor } from './keys.mjs';
import { buildMint, buildTransfer, buildList, buildBuy, buildClaim } from './actions.mjs';
import { mintPsbt, buyPsbt, selfPublishPsbt, escapePsbt, sweepPsbt } from './txs.mjs';
import { keyPathSigner, leafSigner, p2trScriptOf } from './signers.mjs';
import { LOCK_ESCAPE_CSV_EXPORT as LOCK_ESCAPE_CSV } from './scripts-compat.mjs';

export class ShieldedClient {
  constructor({ platformUrl, network, zk, fetch: f = globalThis.fetch.bind(globalThis) }) {
    this.base = platformUrl.replace(/\/+$/, '');
    this.network = network;
    this.zk = zk;
    this.fetch = f;
    this.state = null;
  }

  async api(method, path, body) {
    const r = await this.fetch(this.base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status });
    return j;
  }

  async load() {
    const c = await this.api('GET', '/collection');
    this.collection = c;
    this.parentId = c.rulesInscriptionId;
    this.rules = parseRules(c.rules);
    return this.refresh();
  }

  async refresh() {
    const [state, inscriptions, status] = await Promise.all([this.api('GET', '/state'), this.api('GET', '/inscriptions'), this.api('GET', '/status')]);
    this.state = state;
    this.inscriptions = inscriptions;
    this.status = status;
    return state;
  }

  async feeRate() { return (await this.api('GET', '/fees')).feeRate; }

  /** The vault's pieces, its listings, and sale proceeds waiting on payout keys. */
  view(vault) {
    const s = scanState(vault, this.state);
    const proceeds = s.listings.filter((l) => l.state === 'SOLD').map((l) => {
      const payout = payoutKeyFor(vault, BigInt(l.nf));
      return p2trScriptOf(payout.xonly).toString('hex') === l.sellerScript ? { listing: l, payout } : null;
    }).filter(Boolean);
    const height = this.state.lastHeight;
    const listings = s.listings.map((l) => ({ ...l, escapeAt: l.height + LOCK_ESCAPE_CSV, canEscape: l.state === 'ACTIVE' && height + 1 >= l.height + LOCK_ESCAPE_CSV }));
    return { ...s, listings, proceeds };
  }

  unminted() {
    const minted = new Set(this.state.minted);
    return Array.from({ length: this.rules.supply }, (_, i) => i).filter((i) => !minted.has(i));
  }

  market(vault) {
    const mine = vault ? new Set(this.view(vault).listings.map((l) => l.nf)) : new Set();
    return this.state.listings.filter((l) => l.state === 'ACTIVE' && !mine.has(l.nf));
  }

  /** Price of one mint of `count` pieces with `tickets` relay tickets each (network fee excluded). */
  mintCost(count, tickets) {
    const R = this.rules;
    return count * (R.mintPrice + R.mintFee + R.inscribeFee + tickets * R.ticketPrice);
  }

  async #finish(psbt, payer, payerIndexes, { platform = false } = {}) {
    let p = await payer.signPsbt(psbt, payerIndexes);
    if (platform) p = bitcoin.Psbt.fromBase64((await this.api('POST', '/sign', { psbt: p.toBase64() })).psbt, { network: this.network });
    p.finalizeAllInputs();
    return (await this.api('POST', '/broadcast', { hex: p.extractTransaction().toHex() })).txid;
  }

  #fundingIndexes(psbt, payer) {
    return psbt.data.inputs.map((inp, i) => (Buffer.from(inp.witnessUtxo.script).equals(Buffer.from(payer.script)) ? i : -1)).filter((i) => i >= 0);
  }

  /** Mint `count` random unminted pieces (or exactly `assetIds`) into the vault. */
  async mint({ vault, payer, count = 1, assetIds, ticketsPerPiece = 2, feeRate }) {
    if (!assetIds) {
      const free = this.unminted();
      if (free.length < count) throw new Error(`only ${free.length} pieces left`);
      assetIds = [];
      while (assetIds.length < count) {
        const pick = free.splice(Math.floor(Math.random() * free.length), 1)[0];
        assetIds.push(pick);
      }
    }
    const { gate } = await this.api('POST', '/mint/reserve');
    const mint = buildMint({ rulesInscriptionId: this.parentId, vault, assetIds, ticketsBuy: ticketsPerPiece });
    const { psbt, fee } = mintPsbt({ rules: this.rules, network: this.network, gate, mint, count: assetIds.length, funding: await payer.coins(), changeScript: payer.script, feeRate: feeRate ?? await this.feeRate() });
    const txid = await this.#finish(psbt, payer, this.#fundingIndexes(psbt, payer), { platform: true });
    return { txid, assetIds, networkFee: fee };
  }

  /** Private send. Uses a relay ticket when the piece has one; otherwise the payer self-publishes. */
  async send({ vault, note, to, payer, feeRate }) {
    if (note.tickets > 0) {
      const t = await buildTransfer({ rulesInscriptionId: this.parentId, vault, note, to, state: this.state, zk: this.zk, spend: 1 });
      return { relay: await this.api('POST', '/relay', { envelopeHex: t.data.toString('hex') }) };
    }
    if (!payer) throw new Error('this piece has no relay ticket left: connect a wallet to pay the network fee');
    const t = await buildTransfer({ rulesInscriptionId: this.parentId, vault, note, to, state: this.state, zk: this.zk, spend: 0 });
    const { psbt } = selfPublishPsbt({ rules: this.rules, network: this.network, data: t.data, funding: await payer.coins(), changeScript: payer.script, feeRate: feeRate ?? await this.feeRate() });
    return { txid: await this.#finish(psbt, payer, this.#fundingIndexes(psbt, payer)) };
  }

  /** List for `price` sats. Proceeds go to a fresh payout key only this vault can spend. */
  async list({ vault, note, price, payer, feeRate }) {
    const sellerScript = p2trScriptOf(payoutKeyFor(vault, note.nf).xonly);
    if (note.tickets > 0) {
      const l = await buildList({ rulesInscriptionId: this.parentId, vault, note, price, sellerScript, state: this.state, zk: this.zk, spend: 1 });
      return { relay: await this.api('POST', '/relay', { envelopeHex: l.data.toString('hex') }) };
    }
    if (!payer) throw new Error('this piece has no relay ticket left: connect a wallet to pay the network fee');
    const l = await buildList({ rulesInscriptionId: this.parentId, vault, note, price, sellerScript, state: this.state, zk: this.zk, spend: 0 });
    const { psbt } = selfPublishPsbt({ rules: this.rules, network: this.network, data: l.data, lockFor: l.returnKey, funding: await payer.coins(), changeScript: payer.script, feeRate: feeRate ?? await this.feeRate() });
    return { txid: await this.#finish(psbt, payer, this.#fundingIndexes(psbt, payer)) };
  }

  /** Cancel an active listing: the platform spends the lock and publishes the CLAIM, paying the fee. */
  async cancel({ vault, listing }) {
    const claim = buildClaim({ rulesInscriptionId: this.parentId, vault, listing, spend: 0 });
    return this.api('POST', '/cancel', { claimHex: claim.data.toString('hex') });
  }

  /** Buy a listing into the vault. */
  async buy({ vault, payer, listing, ticketsBuy = 0, feeRate }) {
    const buy = buildBuy({ rulesInscriptionId: this.parentId, vault, listing, ticketsBuy });
    const { psbt } = buyPsbt({ rules: this.rules, network: this.network, listing, buy, ticketsBuy, funding: await payer.coins(), changeScript: payer.script, feeRate: feeRate ?? await this.feeRate() });
    return { txid: await this.#finish(psbt, payer, this.#fundingIndexes(psbt, payer), { platform: true }) };
  }

  /** The seller's escape hatch, no platform needed: after 1008 blocks, take the piece back alone. */
  async escape({ vault, payer, listing, feeRate }) {
    const claim = buildClaim({ rulesInscriptionId: this.parentId, vault, listing, spend: 0 });
    const { psbt } = escapePsbt({ rules: this.rules, network: this.network, listing, claim, funding: await payer.coins(), changeScript: payer.script, feeRate: feeRate ?? await this.feeRate() });
    psbt.signInput(0, leafSigner(returnKeyFor(vault, BigInt(listing.nf))));
    return { txid: await this.#finish(psbt, payer, this.#fundingIndexes(psbt, payer)) };
  }

  /**
   * Sweep sale proceeds to `toScript`. `isUnspent(txid, vout)` checks a payout coin is still there
   * (the platform's node or an esplora API); swept coins are skipped.
   */
  async withdraw({ vault, toScript, isUnspent, feeRate }) {
    const coins = [];
    for (const { listing, payout } of this.view(vault).proceeds) {
      const tx = bitcoin.Transaction.fromHex(await this.rawTx(listing.soldTxid));
      const vout = tx.outs.findIndex((o) => Buffer.from(o.script).toString('hex') === listing.sellerScript);
      if (vout < 0 || !(await isUnspent(listing.soldTxid, vout))) continue;
      coins.push({ txid: listing.soldTxid, vout, value: tx.outs[vout].value, xonly: payout.xonly, priv: payout.priv });
    }
    if (!coins.length) throw new Error('no sale proceeds waiting');
    const { psbt } = sweepPsbt({ network: this.network, coins, to: toScript, feeRate: feeRate ?? await this.feeRate() });
    coins.forEach((c, i) => psbt.signInput(i, keyPathSigner(Buffer.from(c.priv).toString('hex'))));
    psbt.finalizeAllInputs();
    return { txid: (await this.api('POST', '/broadcast', { hex: psbt.extractTransaction().toHex() })).txid, amount: coins.reduce((s, c) => s + c.value, 0) };
  }

  async rawTx(txid) { return (await this.api('GET', `/tx/${txid}`)).hex; }
}

/** A payer backed by a raw key: tests and the regtest dev wallet. */
export function keyPayer({ priv, network, coins }) {
  const signer = keyPathSigner(priv);
  const pay = bitcoin.payments.p2tr({ internalPubkey: signer.xonly, network });
  return {
    address: pay.address, script: pay.output,
    coins: async () => (await coins(pay.address)).map((c) => ({ ...c, script: pay.output, tapInternalKey: signer.xonly })),
    async signPsbt(psbt, indexes) { for (const i of indexes) psbt.signInput(i, signer); return psbt; },
  };
}

/** Ask the platform whether a coin is still unspent (for withdraw). */
export const platformUnspent = (client) => async (txid, vout) => (await client.api('GET', `/utxo/${txid}/${vout}`)).unspent;
