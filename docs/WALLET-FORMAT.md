# Shielded Degents wallet format (v1)

SHORD v1 fixes what goes on chain. It leaves key derivation, the address encoding and the note-encryption
key schedule to the wallet. This is the Shielded Degents definition. Any wallet that implements it can
open a Shielded Degents vault. Reference code: `packages/sdk/src/keys.mjs` and `notes.mjs`.

`P` is the BN254 scalar field order. `n` is the secp256k1 group order. `|` is byte concatenation.
Tags are ASCII.

## Seed and keys

A vault is one 32-byte random seed.

| Key | Derivation |
|---|---|
| spend key `sk` | `int(sha512("SD/sk" \| seed)) mod P` (must be non-zero) |
| owner key `pk` | `Poseidon(sk)` (circomlib parameters, width 1) |
| view key | `viewPriv = sha256("SD/view" \| seed)`, `viewPk = X25519(viewPriv)` |
| listing return key | `int(sha256("SD/return" \| seed \| be32(listingNf))) mod n`, BIP340 x-only |
| listing payout key | `int(sha256("SD/payout" \| seed \| be32(listingNf))) mod n`, paid to BIP86 `P2TR(xonly)` |

`listingNf` is the nullifier of the note being listed, so a wallet restored from its seed re-derives
every return and payout key from public listing data.

## Address

`bech32m("shord", be32(pk) | viewPk)`, encoded without the 90-character limit. It starts with `shord1`.

## Note encryption

```
eph      random 32 bytes             epk = X25519(eph)
shared   X25519(eph, viewPk)
key      sha256("SD/note-key/v1" | shared | epk | viewPk)
pt       u32le assetId | u32le tickets | be32(rho) | be32(s)          (72 bytes)
ct       ChaCha20-Poly1305(key, nonce = 12 zero bytes, pt)            (88 bytes)
```

The key is unique per `epk`, so the fixed nonce never repeats under one key.

## Scanning

For each note `{ epk, ct, cm }` in the indexer's `/state`, decrypt. If decryption succeeds, keep the note
only if `Poseidon(assetId, tickets, Poseidon(pk, rho, s)) == cm`. The note is spent when
`Poseidon(sk, rho, 7)` is in `nullifiers`.

## Note secrets

- Mint, buy, claim: `rho` and `s` are fresh uniform field elements (below 2^254, non-zero).
- Private send: `rho_out = Poseidon(nf, 11)` (fixed by the circuit), `s` unchanged.

## Backup

The backup is the 64-character hex seed. On the device, the web vault stores it encrypted with
PBKDF2-SHA256 (310,000 iterations, 16-byte salt) and AES-256-GCM (`apps/web/src/vault-store.mjs`).
