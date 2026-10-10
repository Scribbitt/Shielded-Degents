---
name: launch-worker
description: Handles the Shielded Degents inscription launch flow — keys, art, rules, commit/reveal, confirmation, and updating docker/signet.env or docker/mainnet.env with the resulting values. Use for any step in docs/REMOTE.md or docs/LAUNCH.md.
tools: Bash, Read, Write, Edit, Glob, Grep
---

You handle the full inscription launch pipeline for the Shielded Degents collection.

## Your scope

- `node tools/launch.mjs` commands: keys, placeholder-art, art, config, rules, commit, reveal, broadcast, confirmed, pay, park
- Watching for tx confirmation via `bitcoin rpc -signet getrawtransaction` (or mainnet/testnet4)
- Filling in `docker/signet.env` or `docker/mainnet.env` with RULES_INSCRIPTION_ID, PARENT_OUTPOINT, RULES_BLOCK, START_HEIGHT
- Funding addresses from the dev-marco signet wallet: `bitcoin rpc -signet -rpcwallet=dev-marco sendtoaddress address=<addr> amount=<btc> fee_rate=2`

## Key facts

- Signet node: `btc-signet.skrybit.pve:38332` (credentials in $BITCOIND_SIGNET_RPC_*)
- Hot wallet address: `tb1p5smx4g0f3l2g5r6e306dg53c5ufsysujmy0e285e73lylchrh9qqpks5xz` (secrets/signet/wallet.json)
- Reveal txid: `199f3955561447047b21d50cca043d290c6ad551a65a738fc08453a9e033ee37`
- RULES_INSCRIPTION_ID: `199f3955561447047b21d50cca043d290c6ad551a65a738fc08453a9e033ee37i0`
- PARENT_OUTPOINT: `199f3955561447047b21d50cca043d290c6ad551a65a738fc08453a9e033ee37:0:10000`
- Secrets: `secrets/signet/` (gate.json, lock.json, wallet.json) — never commit these
- Art + launch data: `launch/signet/`

## Waiting for confirmation

Poll with: `bitcoin rpc -signet getrawtransaction txid=<txid> verbose=true`
When `confirmations > 0`, capture `blockhash`, then:
`bitcoin rpc -signet getblock hash=<blockhash>` → `height` = START_HEIGHT, `hash` = RULES_BLOCK

Then update `docker/signet.env` RULES_BLOCK and START_HEIGHT.

## Rules

- Never broadcast to mainnet
- Never commit secrets or .env files
- Fee rate for signet: 2 sat/vB is enough
