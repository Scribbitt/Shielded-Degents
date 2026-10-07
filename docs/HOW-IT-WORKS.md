# How Shielded Degents works

Shielded Degents is a clone of [Shielded Nakas](https://ord-dropz.xyz/secondary/collections/shielded-nakas-mupv6wja)
(Ord Dropz) built on the same open protocol, **SHORD v1**, with our own keys, addresses, art and services.
Because the on-chain rules are identical, the reference indexer anyone runs for Nakas also verifies our
collection, unmodified. This document explains the whole system from the bottom up.

## 1. The idea in one paragraph

The art of every piece is a normal, public ordinal inscription. **Who owns a piece is not tied to a
Bitcoin address.** Ownership is a secret *note* whose fingerprint (a *commitment*) sits in a Merkle
tree that everybody can rebuild from Bitcoin blocks. Only the owner's vault can open its notes. To move
a piece, the owner publishes a zero-knowledge proof that says "I own one of the notes in this tree"
without saying which one. Every action is an ordinary Bitcoin transaction with one `OP_RETURN`
message. There is no token, sidechain or bridge.

## 2. Where everything lives

```
 Bitcoin blocks ─────────────────────────────────────────────────────────────────────────────
   parent inscription (rules JSON)   children (art, parked at NUMS)   OP_RETURN "SHORD…" messages
        ▲                                   ▲                                   ▲
        │ inscribed once at launch          │ inscriber, after each mint        │ every action
 ───────┼───────────────────────────────────┼───────────────────────────────────┼──────────────
        │                                   │                                   │
 ┌──────┴────────────── platform service (services/platform) ──────────────────┴───────────┐
 │ indexer (vendor, unmodified)  signer (gate + lock keys)  relayer  inscriber  gate pool  │
 │ read API: /status /collection /state /listings     actions: /mint/reserve /sign        │
 │                                                     /relay /cancel /broadcast           │
 └───────────────────────────────────────────▲──────────────────────────────────────────────┘
                                             │ envelopes + PSBTs only (never keys)
 ┌───────────────────────────────────────────┴──────────────────────────────────────────────┐
 │ web vault (apps/web) = ShieldedClient (packages/sdk)                                     │
 │ vault seed (encrypted, this device)  note scan  Groth16 prover  PSBT builders            │
 │ + the user's bitcoin wallet (Unisat / OKX / Xverse) to pay                               │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

| Piece | Who wrote it | Path |
|---|---|---|
| Protocol rules, indexer, circuits, relayer, co-signer | Ord Dropz (MIT), vendored unmodified except one env var | `vendor/shielded-ordinals/` |
| Wallet: keys, note encryption, scanning, proofs, every transaction builder | **us** (Ord Dropz keeps theirs closed) | `packages/sdk/` |
| Platform: signer policy, gate pool, relay batches, inscriber, HTTP API | **us** | `packages/platform/`, `services/platform/` |
| Web vault | **us** | `apps/web/` |
| Launch tool (keys, art, rules, parent, park) | **us** | `tools/launch.mjs` |
| Trusted setup | public Powers of Tau + our phase-2 ceremony | `zk/` |

## 3. The collection is its rules

The **parent inscription** is a JSON document (`"p": "shord", "v": 1`) with everything the indexer
needs: supply, prices, fees, payout scripts, the platform's two keys (`gateKey`, `lockKey`), the art
commitment and the hash of the proof verification key. The indexer reads it straight out of the
parent's reveal transaction. After mint-out the parent is sent to an unspendable address (NUMS), so
the rules can never change.

**Art ("file mint" mode).** The rules carry `artRoot`, a Merkle root over every piece's file
(`leaf = sha256(0x00 | u32le id | sha256(file))`). Nothing is inscribed up front. After a piece is
minted, the inscriber inscribes its file as a true child of the parent (ord tag 3) and parks it at
NUMS. Anyone can prove a child is piece N: hash the file and check the Merkle path against `artRoot`.
The shuffle of the art stays private until mint-out, so nobody can snipe rare pieces by number.

**Becoming an official Degent.** The rules parent can itself be inscribed as a child of the
Decentralized Gentlemen Club parent (`tools/launch.mjs commit --grandparent`). That needs the holder
of the DGC parent to sign the reveal. Tested on regtest in `test/e2e-launch.mjs`.

## 4. Notes: what "owning" a piece means

```
note        (assetId, tickets, ownerPk, rho, s)
ownerPk     Poseidon(sk)                      sk = the vault's spend key
inner       Poseidon(ownerPk, rho, s)
commitment  cm = Poseidon(assetId, tickets, inner)       ← the Merkle leaf, public
nullifier   nf = Poseidon(sk, rho, 7)                    ← published when the note is spent
```

- `rho` makes every note unique. `s` is the *piece secret*: it survives private sends and is replaced on
  every sale, mint or claim.
- The note's plaintext is encrypted to the owner's view key (x25519 + ChaCha20-Poly1305, 88 bytes).
  The vault downloads every note from `/state` and tries to open each one **on the device**, so the
  server never learns which notes are yours.
- Spending a note publishes its nullifier. Only the owner can compute it (it needs `sk`), and nobody can
  link it back to the commitment. A note whose nullifier is already known can't be spent again: that
  is the double-spend rule.
- `tickets` are prepaid relay credits that travel with the piece (see §6).

## 5. The proof

`circuits/spend.circom` (14.5k constraints, Groth16 on BN254, about 1 s to prove in a browser) proves:

1. the input note is a leaf of the tree under a recent `root`, and the prover knows its `sk`;
2. `nf` is that note's nullifier;
3. `tickets − spend + buy ≥ 0`;
4. **send (mode 0):** the output commitment holds the *same* piece and `s`, for the recipient's key;
5. **list (mode 1):** the piece number and tickets become public (a listing has to show what is for sale);
6. the proof is bound to the exact message bytes (`hbody`), so nobody can lift it into another message.

Groth16 needs a trusted setup. Phase 1 is the public Perpetual Powers of Tau (thousands of
contributors). Phase 2 is per circuit and is what the parent pins (`spendVkeyHash`): the key is safe if
**any one** contributor destroyed their randomness. Ord Dropz ran theirs with a single contributor. The
dev key in `zk/dev-ceremony` is ours and is refused on mainnet. See `docs/LAUNCH.md` for the public
ceremony.

## 6. Every action, as a transaction

| Action | Message | Proof / authority | Who pays the miner | Platform signs |
|---|---|---|---|---|
| Mint | `MINT` / `MINTN` (up to 20) | none: it must spend a gate coin | buyer | the gate coin |
| Send | `TRANSFER` | Groth16 (mode 0) | relayer (1 ticket) or the sender | nothing |
| List | `LIST` + a lock output | Groth16 (mode 1) | relayer (1 ticket) or the seller | nothing |
| Buy | `BUY` | none: it must spend the listing lock | buyer | the lock |
| Cancel | `CLAIM` | the seller's signature (return key) | the platform | the lock |
| Take back alone | `CLAIM` | the seller's signature + the lock's escape leaf after 1008 blocks | the seller | nothing |

**Mint gate.** Every mint must spend a coin at `P2TR(gateKey)`. The platform signs it only after its own
indexer checks the mint would be accepted (price paid, pieces unminted, not in another pending mint).
That is how a piece is never minted twice, even in the mempool. Our mint transaction returns the gate
coin's value to the gate address, so the pool refills itself.

**Listing lock.** A listing creates a 330-sat output `P2TR(internal = lockKey, leaf = "<1008> CSV DROP
<returnKey> CHECKSIG")`. A `BUY` is valid only in a transaction that spends that exact output, so
Bitcoin consensus itself makes each listing sell at most once. The platform co-signs the lock only for
a correct sale or the seller's signed cancel. The leaf is the seller's escape hatch: after 1008 blocks
the seller can spend the lock alone and claim the piece back, with no platform at all.

**Relay tickets.** Paying fees from your own wallet links that wallet to the action. With a ticket, the
relayer publishes your message from its own wallet, batched with others in random order at a random
time, so the chain can't tell who did what. Tickets are bought at mint (or topped up) and paid to the
relayer address in the rules.

**Payouts.** A seller's price goes to a fresh BIP86 key derived from the vault seed and that listing.
The vault finds its sales by scanning and sweeps them with "Withdraw". No server holds them.

## 7. Trust model

| The platform **can** | The platform **cannot** |
|---|---|
| refuse to sign a mint or a sale (liveness) | move a piece, or see which pieces are yours |
| delay or drop a relayed message (use another relayer, or self-publish) | change a message: proofs and signatures bind every byte |
| | keep an unsold listing locked for more than 1008 blocks |
| | forge a piece, if the ceremony had one honest contributor |

**What everybody can check:** run `vendor/shielded-ordinals/indexer/indexer.mjs` against your own
Bitcoin node and compare its digest with ours (`--compare https://<platform>/status`). We did exactly
that against the dev stack: `AGREE: the same state at the same block`.

**Known limits (same as Nakas):**
- Message sizes exceed the old 83-byte `OP_RETURN` standardness limit. Bitcoin Core 30 relays them, but
  pools on older policy skip them, so a transaction waits for the next pool that accepts it. Raising the
  fee doesn't help.
- One key signs mints and sales. The protocol also supports a 2-of-3 co-signer mode
  (`rules.cosigners`, `vendor/shielded-ordinals/cosigner`). That's a future upgrade for a later
  collection: the rules of a launched collection can't change.
- A web vault is only as safe as the device and the backup.

## 8. What we built vs what Ord Dropz published

Ord Dropz published the rules (indexer), circuits, relayer and co-signer. They kept the wallet and every
transaction builder private ("building on the protocol goes through the Ord Dropz API"). We wrote
those ourselves against the published rules and proved them correct the only way that matters: the
unmodified reference indexer accepts every transaction we build (`npm run test:all`).

Our wallet formats (key derivation, addresses, note encryption) are our own, documented in
`docs/WALLET-FORMAT.md`. A vault made on Ord Dropz's site does not open in ours, and vice versa. The
on-chain messages are identical.
