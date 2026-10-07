// Relay batches: queue relayed envelopes (TRANSFER / LIST with spend 1, CLAIM of a cancelled listing)
// and publish them together from the hot wallet, in random order, at a random moment in each window,
// so the chain can't match an action to when it was submitted. Same rules and API as the vendor's
// relayer (relayer/relayer.mjs), which needs an esplora API; this one runs on any chainIO backend.
//
// The relayer can't change anything: every envelope is bound by a proof or the seller's signature.
// It can only publish as-is, delay or drop, and the user can always self-publish instead.
import crypto from 'node:crypto';
import { parseEnvelope, T } from '../../../vendor/shielded-ordinals/src/v1/envelope.mjs';
import { lockScript } from '../../sdk/src/scripts-compat.mjs';
import { opReturn, LOCK_VALUE } from '../../sdk/src/txs.mjs';

export function relayQueue({ rules, network, wallet, io, store, maxBatch = 40 }) {
  const st = () => store.get().relay ?? { queue: [], keys: {} };
  const save = (relay) => store.set({ relay });
  const keyOf = (env) => String(env.type === T.CLAIM ? env.listingNf : env.nf);
  const pendingKeys = (relay, except) => new Set(Object.keys(relay.keys).filter((k) => k !== except).map(BigInt));
  const view = (q) => ({ id: q.id, state: q.state, txid: q.txid ?? null, error: q.error ?? null });

  async function submit(ix, envelopeHex) {
    const data = Buffer.from(String(envelopeHex), 'hex');
    const env = parseEnvelope(data);
    if (!env) throw new Error('not a shielded ordinals envelope');
    const relay = st();
    const check = await ix.checkRelay(env, ix.lastHeight + 1, pendingKeys(relay));
    if (!check.ok) throw new Error(check.reason);
    const q = { id: crypto.randomUUID(), envelopeHex: data.toString('hex'), key: keyOf(env), at: Date.now(), state: 'queued' };
    relay.queue.push(q);
    relay.keys[q.key] = `queued:${q.id}`;
    save(relay);
    return view(q);
  }

  const status = (id) => { const q = st().queue.find((x) => x.id === id); return q ? view(q) : null; };

  async function flush(ix) {
    const relay = st();
    const items = relay.queue.filter((q) => q.state === 'queued').slice(0, maxBatch);
    if (!items.length) return null;
    const ok = [];
    for (const q of items) {
      const env = parseEnvelope(Buffer.from(q.envelopeHex, 'hex'));
      const check = await ix.checkRelay(env, ix.lastHeight + 1, pendingKeys(relay, q.key));
      if (check.ok) ok.push({ q, env }); else { q.state = 'failed'; q.error = check.reason; delete relay.keys[q.key]; }
    }
    let txid = null;
    if (ok.length) {
      for (let i = ok.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ok[i], ok[j]] = [ok[j], ok[i]]; }
      const outputs = ok.flatMap(({ q, env }) => [
        { script: opReturn(Buffer.from(q.envelopeHex, 'hex')), value: 0 },
        ...(env.type === T.LIST ? [{ script: lockScript(rules, env.returnKey, network), value: LOCK_VALUE }] : []),
      ]);
      try {
        const tx = await wallet.pay({ outputs, feeRate: await io.feeRate() });
        txid = await io.broadcast(tx.hex);
        for (const { q } of ok) { q.state = 'sent'; q.txid = txid; relay.keys[q.key] = txid; }
      } catch (e) {
        for (const { q } of ok) { q.tries = (q.tries ?? 0) + 1; if (q.tries >= 3) { q.state = 'failed'; q.error = 'could not publish: ' + e.message; delete relay.keys[q.key]; } }
      }
    }
    // forget keys whose nullifier / claim is on chain; drop day-old history
    for (const k of Object.keys(relay.keys)) {
      if (relay.keys[k].startsWith('queued:')) continue;
      const l = ix.listings.get(BigInt(k));
      if (ix.nullifiers.has(BigInt(k)) || l?.state === 'CLAIMED') delete relay.keys[k];
    }
    relay.queue = relay.queue.filter((q) => q.state === 'queued' || q.at > Date.now() - 86400_000);
    save(relay);
    return txid ? { txid, count: ok.length } : null;
  }

  return { submit, status, flush, queued: () => st().queue.filter((q) => q.state === 'queued').length };
}
