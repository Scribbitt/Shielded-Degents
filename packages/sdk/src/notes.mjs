// Note encryption and the vault scan.
//
// A note (assetId, tickets, ownerPk, rho, s) travels on chain as epk (32 B) + ct (88 B):
//   shared = x25519(ephemeralPriv, viewPk)
//   key    = sha256("SD/note-key/v1" | shared | epk | viewPk)
//   ct     = ChaCha20-Poly1305(key, nonce = 12 zero bytes, assetId u32le | tickets u32le | rho 32 | s 32)
// The key is fresh per epk, so a fixed nonce never repeats under one key.
//
// The scan never trusts a decrypted note on its own: it recomputes the commitment from the
// plaintext and the vault's pk and keeps the note only if it equals the leaf the indexer published.
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { P, poseidon, noteCommitment, fieldToBytes, CT_LEN } from '../../../vendor/shielded-ordinals/src/v1/core.mjs';

const NONCE = new Uint8Array(12);
const PT_LEN = 72;

const noteKey = (shared, epk, viewPk) =>
  sha256(Buffer.concat([Buffer.from('SD/note-key/v1'), Buffer.from(shared), Buffer.from(epk), Buffer.from(viewPk)]));

export function randomField() {
  for (;;) {
    const x = BigInt('0x' + Buffer.from(randomBytes(32)).toString('hex')) & ((1n << 254n) - 1n);
    if (x < P && x !== 0n) return x;
  }
}

export const innerOf = (pk, rho, s) => poseidon([pk, rho, s]);
export const nullifierOf = (sk, rho) => poseidon([sk, rho, 7n]);
export const transferRho = (nf) => poseidon([nf, 11n]);

export function encryptNote(viewPk, { assetId, tickets, rho, s }) {
  const eph = Buffer.from(randomBytes(32));
  const epk = Buffer.from(x25519.getPublicKey(eph));
  const shared = x25519.getSharedSecret(eph, viewPk);
  const pt = Buffer.alloc(PT_LEN);
  pt.writeUInt32LE(assetId, 0);
  pt.writeUInt32LE(tickets, 4);
  fieldToBytes(rho).copy(pt, 8);
  fieldToBytes(s).copy(pt, 40);
  const ct = Buffer.from(chacha20poly1305(noteKey(shared, epk, viewPk), NONCE).encrypt(pt));
  if (ct.length !== CT_LEN) throw new Error('ciphertext length');
  return { epk, ct };
}

export function decryptNote(vault, epk, ct) {
  try {
    const shared = x25519.getSharedSecret(vault.viewPriv, epk);
    const pt = Buffer.from(chacha20poly1305(noteKey(shared, epk, vault.viewPk), NONCE).decrypt(ct));
    const big = (b) => BigInt('0x' + b.toString('hex'));
    return { assetId: pt.readUInt32LE(0), tickets: pt.readUInt32LE(4), rho: big(pt.subarray(8, 40)), s: big(pt.subarray(40, 72)) };
  } catch {
    return null;
  }
}

/**
 * A note the vault builds for itself (mint, buy, claim). The indexer computes the commitment
 * from the public assetId + tickets and this `inner`, so these need no proof.
 */
export function ownNote(vault, assetId, tickets) {
  const rho = randomField();
  const s = randomField();
  return { rho, s, inner: innerOf(vault.pk, rho, s), ...encryptNote(vault.viewPk, { assetId, tickets, rho, s }) };
}

/**
 * Find this vault's notes in an indexer's public /state. Runs entirely on the device.
 * Returns every note we can open, each marked spent or not; a listed note is "spent" (its
 * nullifier is published) and shows up in `listings` instead.
 */
export function scanState(vault, state) {
  const spent = new Set(state.nullifiers.map(String));
  const mine = [];
  for (const n of state.notes) {
    const note = decryptNote(vault, Buffer.from(n.epk, 'hex'), Buffer.from(n.ct, 'hex'));
    if (!note) continue;
    const cm = noteCommitment(note.assetId, note.tickets, innerOf(vault.pk, note.rho, note.s));
    if (String(cm) !== n.cm) continue; // decrypts but isn't what was committed: not ours to spend
    const nf = nullifierOf(vault.sk, note.rho);
    mine.push({ ...note, pos: n.pos, cm, nf, txid: n.txid, height: n.height, kind: n.kind, spent: spent.has(String(nf)) });
  }
  const myNfs = new Set(mine.map((n) => String(n.nf)));
  const listings = state.listings.filter((l) => myNfs.has(String(l.nf)));
  return { notes: mine, unspent: mine.filter((n) => !n.spent), listings };
}
