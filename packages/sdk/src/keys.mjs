// Shielded Degents vault keys. Everything comes from one 32-byte seed held on the holder's device.
//
//   sk        spend key, a BN254 field element      sk = sha512("SD/sk" | seed) mod P
//   pk        owner key in every note               pk = Poseidon(sk)
//   viewPriv  x25519 key notes are encrypted to     viewPriv = sha256("SD/view" | seed)
//   address   bech32m, hrp "shord": pk (32 B) | viewPk (32 B)
//
// Per-listing keys (so a wallet restored from its seed can always reclaim and withdraw):
//   returnKey  BIP340 key in the listing lock's escape leaf and on CLAIM   sha256("SD/return" | seed | nf)
//   payoutKey  P2TR key the sale price is paid to                         sha256("SD/payout" | seed | nf)
//
// SHORD v1 fixes what goes on chain; it leaves these derivations to the wallet. This file is the
// Shielded Degents definition of them (docs/WALLET-FORMAT.md). It is NOT the Ord Dropz derivation,
// so a seed from one wallet does not open a vault in the other.
import { Buffer } from 'buffer';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bech32m } from '@scure/base';
import { P, poseidon, fieldToBytes } from '../../../vendor/shielded-ordinals/src/v1/core.mjs';

export const ADDRESS_HRP = 'shord';
const N = secp256k1.Point.CURVE().n;

const tag = (t, ...parts) => Buffer.concat([Buffer.from('SD/' + t), ...parts.map((p) => Buffer.from(p))]);
const toBig = (b) => BigInt('0x' + Buffer.from(b).toString('hex'));
const scalar = (bytes) => {
  // reduce a 32-byte hash into [1, n-1] for secp256k1; the chance of needing the fallback is ~2^-128
  const k = toBig(bytes) % N;
  if (k === 0n) throw new Error('degenerate key');
  return fieldToBytes(k);
};

export const newSeed = () => Buffer.from(randomBytes(32));

export function vaultFromSeed(seed) {
  seed = Buffer.from(seed);
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const sk = toBig(sha512(tag('sk', seed))) % P;
  if (sk === 0n) throw new Error('degenerate spend key');
  const pk = poseidon([sk]);
  const viewPriv = Buffer.from(sha256(tag('view', seed)));
  const viewPk = Buffer.from(x25519.getPublicKey(viewPriv));
  return Object.freeze({ seed, sk, pk, viewPriv, viewPk, address: encodeAddress(pk, viewPk) });
}

export function encodeAddress(pk, viewPk) {
  const bytes = Buffer.concat([fieldToBytes(pk), Buffer.from(viewPk)]);
  return bech32m.encode(ADDRESS_HRP, bech32m.toWords(bytes), false);
}

export function decodeAddress(address) {
  const { prefix, words } = bech32m.decode(address, false);
  if (prefix !== ADDRESS_HRP) throw new Error(`not a shielded address (${prefix})`);
  const b = Buffer.from(bech32m.fromWords(words));
  if (b.length !== 64) throw new Error('bad shielded address length');
  const pk = toBig(b.subarray(0, 32));
  if (pk >= P) throw new Error('bad shielded address key');
  return { pk, viewPk: b.subarray(32) };
}

/** BIP340 key for one listing's escape leaf and CLAIM signature. */
export function returnKeyFor(vault, listingNf) {
  const priv = scalar(sha256(tag('return', vault.seed, fieldToBytes(listingNf))));
  return { priv, xonly: Buffer.from(schnorr.getPublicKey(priv)) };
}

/** Fresh key a sale is paid to (spent by the wallet with a BIP86 key-path signature). */
export function payoutKeyFor(vault, listingNf) {
  const priv = scalar(sha256(tag('payout', vault.seed, fieldToBytes(listingNf))));
  return { priv, xonly: Buffer.from(schnorr.getPublicKey(priv)) };
}
