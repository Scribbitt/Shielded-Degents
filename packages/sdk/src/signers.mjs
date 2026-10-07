// Local signers for keys the vault itself holds (payout keys, return keys, a dev payer). A browser
// wallet (Unisat, Xverse, ...) signs the user's own coins instead; see apps/web/src/btc-wallets.mjs.
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { schnorr } from '@noble/curves/secp256k1.js';

bitcoin.initEccLib(ecc);

/** A BIP341 key-path signer for P2TR(internal = key[, merkleRoot]). */
export function keyPathSigner(privHex, merkleRoot) {
  const priv = Buffer.from(privHex, 'hex');
  const pub = Buffer.from(ecc.pointFromScalar(priv, true));
  const xonly = pub.subarray(1);
  const even = pub[0] === 3 ? Buffer.from(ecc.privateNegate(priv)) : priv;
  const tweak = bitcoin.crypto.taggedHash('TapTweak', merkleRoot ? Buffer.concat([xonly, merkleRoot]) : xonly);
  const tweaked = Buffer.from(ecc.privateAdd(even, tweak));
  const outKey = Buffer.from(ecc.pointFromScalar(tweaked, true));
  return { xonly, publicKey: outKey, signSchnorr: (h) => Buffer.from(ecc.signSchnorr(h, tweaked)) };
}

/** A script-path signer for a leaf that checks `xonly` (the listing escape leaf). */
export const leafSigner = ({ priv, xonly }) => ({
  publicKey: Buffer.concat([Buffer.from([2]), Buffer.from(xonly)]),
  signSchnorr: (h) => Buffer.from(schnorr.sign(h, priv)),
});

export const xonlyOfPriv = (privHex) => Buffer.from(ecc.pointFromScalar(Buffer.from(privHex, 'hex'), true)).subarray(1).toString('hex');
/** BIP86 key-path output for an internal key (what wallets derive and can spend). */
export const p2trScriptOf = (xonly) => bitcoin.payments.p2tr({ internalPubkey: Buffer.from(xonly) }).output;
