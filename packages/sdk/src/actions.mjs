// Envelope builders for every Shielded Ordinals v1 action, from the vault's side.
//
// Each builder returns the exact OP_RETURN payload the indexer accepts (vendor envelope.mjs) plus
// whatever the caller needs to put it in a transaction (e.g. the listing's return key). Proofs are
// made locally with the circuit artifacts given in `zk` ({ wasm, zkey } paths or URLs).
import { Buffer } from 'buffer';
import * as snarkjs from 'snarkjs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hashBody, noteCommitment } from '../../../vendor/shielded-ordinals/src/v1/core.mjs';
import { NoteTree } from '../../../vendor/shielded-ordinals/src/v1/tree.mjs';
import { collectionId, MAX_TICKETS_PER_BUY } from '../../../vendor/shielded-ordinals/src/v1/rules.mjs';
import {
  encodeMint, encodeMintBatch, encodeTransferBody, encodeListBody, encodeBuy, encodeClaimBody, claimSigHash,
  encodeProof, MAX_MINTS_PER_TX,
} from '../../../vendor/shielded-ordinals/src/v1/envelope.mjs';
import { decodeAddress, returnKeyFor } from './keys.mjs';
import { ownNote, encryptNote, innerOf, transferRho } from './notes.mjs';

const checkTickets = (k) => {
  if (!Number.isInteger(k) || k < 0 || k > MAX_TICKETS_PER_BUY) throw new Error(`tickets must be 0..${MAX_TICKETS_PER_BUY}`);
};

/** The tree as it stood after block `height`, rebuilt from a full /state (sinceNote = 0). */
export function anchorOf(state, height) {
  if (state.sinceNote) throw new Error('need the full state (sinceNote = 0) to build Merkle paths');
  const roots = new Map(state.roots.map(([h, root, count]) => [h, { root: BigInt(root), count }]));
  const h = height ?? Math.max(...roots.keys());
  const r = roots.get(h);
  if (!r) throw new Error(`no root for block ${h} in this state`);
  const tree = new NoteTree();
  for (const n of state.notes.slice(0, r.count)) tree.append(BigInt(n.cm));
  if (tree.root() !== r.root) throw new Error(`rebuilt root does not match the indexer's root at ${h}`);
  return { height: h, root: r.root, tree };
}

async function proveSpend(zk, pub, priv) {
  const input = Object.fromEntries(Object.entries({ ...pub, ...priv }).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, zk.wasm, zk.zkey);
  const order = ['root', 'nf', 'hbody', 'cmOut', 'spend', 'buy', 'mode', 'assetIdPub', 'ticketsPub'];
  order.forEach((k, i) => { if (publicSignals[i] !== String(pub[k])) throw new Error(`prover public signal ${k} mismatch`); });
  return encodeProof(proof);
}

function spendWitness(vault, note, anchor) {
  if (note.pos >= anchor.tree.leaves.length) throw new Error('note is newer than the anchor block');
  const { pathElements, pathIndices } = anchor.tree.path(note.pos);
  return { sk: vault.sk, assetId: note.assetId, tickets: note.tickets, rho: note.rho, s: note.s, pathElements, pathIndices };
}

// ─── no-proof actions ────────────────────────────────────────────────────────────────────────

/** Mint one piece (MINT) or a batch (MINTN) into this vault. */
export function buildMint({ rulesInscriptionId, vault, assetIds, ticketsBuy = 0 }) {
  checkTickets(ticketsBuy);
  if (!assetIds.length || assetIds.length > MAX_MINTS_PER_TX) throw new Error(`mint 1..${MAX_MINTS_PER_TX} pieces per tx`);
  const cid = collectionId(rulesInscriptionId);
  const mints = assetIds.map((assetId) => ({ assetId, ticketsBuy, ...ownNote(vault, assetId, ticketsBuy) }));
  const data = mints.length === 1 ? encodeMint({ cid, ...mints[0] }) : encodeMintBatch({ cid, mints });
  return { data, notes: mints, tickets: ticketsBuy * assetIds.length };
}

/** Buy an ACTIVE listing into this vault. The carrier tx must spend the listing's lock. */
export function buildBuy({ rulesInscriptionId, vault, listing, ticketsBuy = 0 }) {
  checkTickets(ticketsBuy);
  const note = ownNote(vault, listing.assetId, listing.tickets + ticketsBuy);
  const data = encodeBuy({ cid: collectionId(rulesInscriptionId), listingNf: BigInt(listing.nf), ticketsBuy, ...note });
  return { data, note };
}

/** Take a listed piece back as a note (after a cancel, or with the seller's escape leaf). */
export function buildClaim({ rulesInscriptionId, vault, listing, spend = 0 }) {
  if (spend !== 0 && spend !== 1) throw new Error('spend is 0 (self-published) or 1 (relayed)');
  if (spend > listing.tickets) throw new Error('no relay ticket left on this piece');
  const nf = BigInt(listing.nf);
  const ret = returnKeyFor(vault, nf);
  if (ret.xonly.toString('hex') !== listing.returnKey) throw new Error('this listing was not made by this vault');
  const note = ownNote(vault, listing.assetId, listing.tickets - spend);
  const body = encodeClaimBody({ cid: collectionId(rulesInscriptionId), listingNf: nf, spend, ...note });
  const sig = Buffer.from(schnorr.sign(claimSigHash(body), ret.priv));
  return { data: Buffer.concat([body, sig]), note };
}

// ─── proof actions ───────────────────────────────────────────────────────────────────────────

/**
 * Private send to a shielded address. spend = 1 pays a relayer one ticket; spend = 0 means the
 * sender self-publishes. `buy` tops up tickets (the carrier tx pays buy x ticketPrice).
 */
export async function buildTransfer({ rulesInscriptionId, vault, note, to, state, zk, spend = 1, buy = 0, anchorHeight }) {
  checkTickets(buy);
  const anchor = anchorOf(state, anchorHeight);
  const ticketsOut = note.tickets - spend + buy;
  if (ticketsOut < 0) throw new Error('no relay ticket on this piece: self-publish (spend 0) or top up');
  const { pk: pkOut, viewPk } = decodeAddress(to);
  const rhoOut = transferRho(note.nf);
  const cmOut = noteCommitment(note.assetId, ticketsOut, innerOf(pkOut, rhoOut, note.s));
  const { epk, ct } = encryptNote(viewPk, { assetId: note.assetId, tickets: ticketsOut, rho: rhoOut, s: note.s });
  const body = encodeTransferBody({ cid: collectionId(rulesInscriptionId), hanchor: anchor.height, nf: note.nf, cmOut, spend, buy, epk, ct });
  const pub = { root: anchor.root, nf: note.nf, hbody: hashBody(body), cmOut, spend, buy, mode: 0, assetIdPub: 0, ticketsPub: 0 };
  const proof = await proveSpend(zk, pub, { ...spendWitness(vault, note, anchor), pkOut });
  return { data: Buffer.concat([body, proof]), cmOut, ticketsOut };
}

/**
 * List a piece for `price` sats. The piece leaves the shielded set into a public listing; the
 * carrier tx must also create the listing lock (scripts.lockScript with the returned returnKey).
 * `sellerScript` is where the price is paid; default is a fresh payout key from the vault seed.
 */
export async function buildList({ rulesInscriptionId, vault, note, price, sellerScript, state, zk, spend = 1, buy = 0, anchorHeight }) {
  checkTickets(buy);
  const anchor = anchorOf(state, anchorHeight);
  const ticketsOut = note.tickets - spend + buy;
  if (ticketsOut < 0) throw new Error('no relay ticket on this piece: self-publish (spend 0) or top up');
  const returnKey = returnKeyFor(vault, note.nf).xonly;
  const body = encodeListBody({
    cid: collectionId(rulesInscriptionId), hanchor: anchor.height, nf: note.nf, assetId: note.assetId, tickets: ticketsOut,
    spend, buy, price: BigInt(price), returnKey, sellerScript,
  });
  const pub = { root: anchor.root, nf: note.nf, hbody: hashBody(body), cmOut: 0n, spend, buy, mode: 1, assetIdPub: note.assetId, ticketsPub: ticketsOut };
  const proof = await proveSpend(zk, pub, { ...spendWitness(vault, note, anchor), pkOut: 0n });
  return { data: Buffer.concat([body, proof]), returnKey, listingNf: note.nf, ticketsOut };
}

/** snarkjs keeps a worker pool alive after proving; call this before a Node process should exit. */
export async function shutdownProver() {
  await globalThis.curve_bn128?.terminate?.();
  delete globalThis.curve_bn128;
}
