# Shielded Degents

Public art on Bitcoin, private owners: a Degent collection whose pieces live in shielded vaults. It's a
working clone of Ord Dropz's [Shielded Nakas](https://ord-dropz.xyz/secondary/collections/shielded-nakas-mupv6wja)
on the same open protocol (SHORD v1), with our own keys, addresses, art, platform and web vault.

**Start with [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).**

## Run it locally

Needs Node 20+ and `bitcoind` 25+ on your PATH.

```bash
npm install
(cd vendor/shielded-ordinals && npm ci && npx circom2 circuits/spend.circom --r1cs --wasm -o build)
npm run dev        # regtest node + launched collection + platform + web vault on http://localhost:8790
```

Or in Docker, with nothing installed but Docker: `docker compose up --build` (same stack, same URL).

On signet or mainnet **without running a node** (GetBlock through `btc-proxy` + mempool.space):
see [docs/REMOTE.md](docs/REMOTE.md).

In the web vault: create a vault, then *Connect wallet → Dev wallet (regtest)*. The dev wallet funds
itself from the faucet. Then mint, send, list, buy, cancel and withdraw. Blocks are mined whenever
something is waiting.

## Tests

```bash
npm test             # offline: SDK envelopes judged by the reference indexer
npm run test:e2e     # regtest: protocol, platform over HTTP, client, launch tool, no-local-node mode (about 50 s)
npm run test:proxy   # the real Caddy btc-proxy in front of a fake GetBlock (needs docker)
npm run test:ui      # headless Chrome against `npm run dev`: two users mint, list, buy, withdraw
```

## Layout

| Path | What |
|---|---|
| `vendor/shielded-ordinals/` | Ord Dropz's protocol, indexer, circuits, relayer, co-signer (MIT). Unmodified except [PATCHES.md](vendor/PATCHES.md) |
| `packages/sdk/` | wallet: keys, note encryption and scan, proofs, transaction builders, `ShieldedClient` |
| `packages/platform/` | signer policy, hot wallet, relay batches, inscriber, chain I/O |
| `services/platform/` | the platform HTTP service |
| `apps/web/` | the web vault (vanilla JS, esbuild) |
| `tools/launch.mjs` | mainnet launch: keys, art, rules, parent (optionally a DGC child), park |
| `zk/dev-ceremony/` | **development** proving keys (one contributor, refused on mainnet) |
| `docs/` | [how it works](docs/HOW-IT-WORKS.md), [wallet format](docs/WALLET-FORMAT.md), [launch checklist](docs/LAUNCH.md) |

## Status

Built and tested end to end on regtest. Not yet run on signet or mainnet. Before mainnet: the public
trusted-setup ceremony, real art, and the steps in [docs/LAUNCH.md](docs/LAUNCH.md). Wallet adapters
for Unisat, OKX and Xverse are written but untested against the real extensions: only the dev wallet
has run.
