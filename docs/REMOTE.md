# Running on signet or mainnet without a Bitcoin node

`docker-compose.remote.yml` runs the platform and the web vault against a real network with no node of
your own:

| Job | Source |
|---|---|
| Blocks (the indexer) | GetBlock through `btc-proxy` (same Caddy pattern as `xcp-api-mime`) when `BITCOIN_RPC=http://btc-proxy`; otherwise mempool.space |
| Hot wallet: coins, fees, broadcast | mempool.space (`MEMPOOL_API`). Hosted shared nodes refuse wallet calls |
| Users' wallets | Unisat / OKX / Xverse; their coins are read from `MEMPOOL_API` |

Pick the network with the env file: `docker/signet.env` or `docker/mainnet.env` (copied from the
`.example` files; both are gitignored). Tested on regtest with stand-ins for both services
(`test/e2e-remote.mjs`, `test/proxy-check.mjs`), and block reads checked against the real mempool.space.
**Not yet run against the real GetBlock.** The indexer needs `getblock` with verbosity 3 (Bitcoin Core 25+)
for mint transactions; confirm the GetBlock node serves it.

## Signet walkthrough (free coins)

You need signet coins in a wallet that can pay to an address (Unisat or Xverse switched to signet, or
a faucet such as https://signetfaucet.com straight to the commit address).

```bash
cp docker/signet.env.example docker/signet.env
API=https://mempool.space/signet/api

# 1. keys: gate + lock sign mints and sales; wallet is the platform's hot wallet
node tools/launch.mjs keys --network signet --out secrets/signet          # note wallet.address

# 2. art: placeholder pixel Degents for the test, then shuffle + art root
node tools/launch.mjs placeholder-art --count 24 --out launch/signet/artist
node tools/launch.mjs art launch/signet/artist launch/signet --name "Shielded Degents"

# 3. rules (cheap test prices; edit launch/signet/config.json to change them)
node tools/launch.mjs config --network signet --secrets secrets/signet --art launch/signet/art --out launch/signet/config.json
node tools/launch.mjs rules --config launch/signet/config.json --out launch/signet/rules.json

# 4. the parent inscription: pay the exact amount it prints to the printed address
node tools/launch.mjs commit --rules launch/signet/rules.json --network signet --fee-rate 2
#    after paying, find <txid>:<vout> of that payment on mempool.space/signet, then:
node tools/launch.mjs reveal --plan launch/signet/parent-plan.json --commit <txid>:<vout> --to <wallet xonly from step 1>
node tools/launch.mjs broadcast --api $API --hex <the reveal hex>
node tools/launch.mjs confirmed --api $API --txid <reveal txid>             # after ~10 min: RULES_BLOCK + START_HEIGHT
```

5. Fill `docker/signet.env` with `RULES_INSCRIPTION_ID`, `PARENT_OUTPOINT` (printed by `reveal`),
   `RULES_BLOCK` and `START_HEIGHT` (printed by `confirmed`).
6. Send about 200,000 signet sats to the hot wallet address from step 1. It pays for gate coins,
   relay batches, cancels and child inscriptions.
7. Start:

```bash
docker compose -f docker-compose.remote.yml --env-file docker/signet.env up --build
```

Then open http://localhost:8791 (signet uses 8791/5031, so the regtest stack can stay up on 8790), create a vault, connect Unisat or Xverse set to signet, and mint.
Blocks take about 10 minutes, so each action shows up after the next block. Relay batches go out
every ~2 minutes on signet (`BATCH_MS`).

## Mainnet

Same steps with `docker/mainnet.env`, `--network mainnet`, real prices and the `docs/LAUNCH.md`
checklist. Set `GETBLOCK_TOKEN` (the one `xcp-api-mime` uses works if it is a mainnet token) to read
blocks through GetBlock.

`rules` refuses the dev proving key on mainnet. For a throwaway mainnet test collection only,
`--allow-dev-key` lets it through with a warning. The real collection needs the public ceremony.

## Switching networks

Each network has its own env file, keys (`secrets/<network>`), launch folder and platform state
volume. To switch:

```bash
docker compose -f docker-compose.remote.yml --env-file docker/signet.env down
docker compose -f docker-compose.remote.yml --env-file docker/mainnet.env up --build
```

The `platform-state` volume holds the relay queue and the parent's position. Give each network its
own compose project (`-p sd-signet`, `-p sd-mainnet`) so their state never mixes.
