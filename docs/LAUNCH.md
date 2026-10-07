# Launching Shielded Degents on mainnet

Everything here was rehearsed on regtest (`test/e2e-launch.mjs`, `npm run dev`). Nothing below has run
on mainnet yet. **The parent's rules are permanent**, so every step before step 6 is reversible and every
step after it is not.

## 0. Decide

| Decision | Notes |
|---|---|
| Supply, mint price, fees, ticket price | Nakas: 3,333 pieces, 2.5% sale fee (min 1,000 sats), 1,500 sats per ticket |
| Art format and size | `inscribeFee` is one fixed amount per piece, so keep the files a similar size. A 200 KB image costs about 50k vB to inscribe |
| Payout addresses | artist, platform fee and relayer (the relayer must be the hot wallet: tickets and inscribe fees fund it) |
| Official DGC child? | needs the holder of the Decentralized Gentlemen Club parent to sign the parent's reveal |
| Single key or 2-of-3 co-signers | this repo implements single key (the Nakas model). The co-signer mode needs a rules change before launch, plus `vendor/shielded-ordinals/cosigner` |

## 1. Public trusted setup (required)

The dev key in `zk/dev-ceremony` had one contributor and is refused on mainnet by `tools/launch.mjs`.

```bash
cd vendor/shielded-ordinals && npm ci && npx circom2 circuits/spend.circom --r1cs --wasm -o build
ln -s ../../../.ptau/ppot_0080_14.ptau build/pot14.ptau        # public Perpetual Powers of Tau, 2^14
node ceremony/ceremony.mjs init spend --dir ../../zk/ceremony
# each contributor, on their own machine, in turn:
node ceremony/ceremony.mjs contribute spend --name "<name>" --dir ../../zk/ceremony
# announce a FUTURE block height publicly, then once it is mined:
node ceremony/ceremony.mjs beacon spend --height <height> --dir ../../zk/ceremony
node ceremony/ceremony.mjs verify spend --dir ../../zk/ceremony && node ceremony/ceremony.mjs page spend --dir ../../zk/ceremony
```

Invite people outside the team (DGC holders, other ordinals devs). Publish `transcript.html`. Then
build the web app with `ZK_ZKEY=zk/ceremony/spend/final.zkey` and point `spendVkey` at
`zk/ceremony/spend/vkey.json`.

## 2. Keys

```bash
node tools/launch.mjs keys --network mainnet --out secrets/
```

`gate` and `lock` sign mints and sales. `wallet` is the hot wallet. Back all three up offline. The
platform host needs them, but nothing else should.

## 3. Art

```bash
node tools/launch.mjs art <artistDir> launch/ --name "Shielded Degents"
```

`<artistDir>` holds `images/1.png…N.png` and `json/1.json…N.json`. It prints `artRoot`. Keep
`launch/PRIVATE-shuffle.json` private until mint-out.

## 4. Rules

Write `launch/config.json`:

```json
{
  "network": "mainnet", "name": "Shielded Degents", "supply": 3333,
  "artRoot": "<from step 3>", "contentType": "image/png", "inscribeFee": 15000,
  "mintPrice": 100000, "mintFee": 5000, "saleFeeBps": 250, "saleFeeMin": 1000, "ticketPrice": 1500,
  "artistPayout": "bc1p…", "platformPayout": "bc1p…", "relayerPayout": "<wallet xonly from step 2>",
  "gateKey": "<gate xonly>", "lockKey": "<lock xonly>", "spendVkey": "zk/ceremony/spend/vkey.json"
}
```

```bash
node tools/launch.mjs rules --config launch/config.json --out launch/rules.json
```

It refuses anything the indexer would refuse, and the dev key on mainnet. Read `rules.json` one last time.

## 5. Infrastructure

- **Bitcoin Core 30+** (relays the larger `OP_RETURN` messages), `txindex=1` recommended. The
  platform uses RPC: `BITCOIN_RPC`, `BITCOIN_RPC_COOKIE`.
- Platform: `npm run platform` with the env listed at the top of `services/platform/server.mjs`. Put it
  behind TLS, set `CORS_ORIGIN` to the web origin, and run it under a supervisor. `STATE_FILE` holds the
  relay queue and the parent's position: back it up.
- Web: `CONFIG=apps/web/config.mainnet.json ZK_ZKEY=… npm run build:web`, then host `apps/web/dist`
  on any static host. Set `esploraUrl` (for example `https://mempool.space/api`) for wallet coins.
- Fund the hot wallet: gate coins (pool × 600 sats), relay batches and cancels.

## 6. Inscribe the parent (permanent)

```bash
node tools/launch.mjs commit --rules launch/rules.json --network mainnet --fee-rate <rate> [--grandparent <DGC parent id>]
# pay the exact amount to the printed address, then:
node tools/launch.mjs reveal --plan launch/parent-plan.json --commit <txid>:<vout> --to <wallet xonly> \
  [--grandparent-utxo <txid>:<vout>:<value> --grandparent-key <file>]
```

Broadcast the printed hex. When it confirms, start the platform with the printed
`RULES_INSCRIPTION_ID`, `PARENT_OUTPOINT`, `RULES_BLOCK` and `START_HEIGHT`. Add the collection to
`vendor/shielded-ordinals/src/v1/collections.mjs` so anyone can run `COLLECTION=shielded-degents`.

## 7. Before opening the mint

- Mint one piece yourself and run the whole flow: inscriber child, send, list, buy, cancel, withdraw.
- Run the independent indexer against your own node and `--compare` with the platform.
- Publish: parent id, the ceremony transcript, the vkey hash, and the art file list (after mint-out).

## 8. After mint-out

```bash
node tools/launch.mjs park --network mainnet --parent <txid>:<vout>:<value> --wallet-key secrets/wallet.json --fee-coin <txid>:<vout>:<value> --fee-rate <rate>
```

The parent moves to NUMS and the rules are final. Then publish `PRIVATE-shuffle.json`.
