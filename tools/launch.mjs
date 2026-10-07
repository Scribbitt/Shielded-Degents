// Launch a Shielded Degents collection, step by step. Every step prints what it did and what is next;
// nothing is broadcast by this tool. You broadcast the hex it prints (your node or mempool.space).
//
//   node tools/launch.mjs keys        --network mainnet --out secrets/
//   node tools/launch.mjs art         <artistDir> <outDir> --name "Shielded Degents"
//   node tools/launch.mjs rules       --config launch/config.json --out launch/rules.json
//   node tools/launch.mjs commit      --rules launch/rules.json --network mainnet --fee-rate 5 [--grandparent <id>]
//   node tools/launch.mjs reveal      --plan launch/parent-plan.json --commit <txid>:<vout> [--grandparent-utxo <txid>:<vout>:<value> --grandparent-key <file>]
//   node tools/launch.mjs park        --network mainnet --parent <txid>:<vout>:<value> --wallet-key secrets/wallet.json --fee-coin <txid>:<vout>:<value> --fee-rate 5
//
// The parent's reveal sends the parent to the platform hot wallet (it carries it while children are
// inscribed). After the last child, `park` moves it to NUMS: the rules can never change again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'buffer';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { parseRules, vkeyHash } from '../vendor/shielded-ordinals/src/v1/rules.mjs';
import { planInscriptions, revealTx, revealVsize, numsScript, NETWORKS } from '../packages/sdk/src/inscribe.mjs';
import { xonlyOfPriv } from '../packages/sdk/src/signers.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
const need = (k) => { const v = flag(k); if (v === undefined) throw new Error(`${k} is required`); return v; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));
const readKey = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).priv;
const outpoint = (s) => { const [txid, vout, value] = s.split(':'); return { txid, vout: Number(vout), value: value === undefined ? undefined : Number(value) }; };
const p2trAddress = (xonlyHex, network) => btc.p2tr(hex.decode(xonlyHex), undefined, NETWORKS[network]).address;
const p2trScriptHex = (xonlyHex, network) => hex.encode(btc.p2tr(hex.decode(xonlyHex), undefined, NETWORKS[network]).script);

const commands = {
  keys() {
    const network = need('--network');
    const out = need('--out');
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const made = {};
    for (const name of ['gate', 'lock', 'wallet']) {
      const file = path.join(out, `${name}.json`);
      if (fs.existsSync(file)) throw new Error(`${file} exists: refusing to overwrite a key`);
      const priv = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(file, JSON.stringify({ priv }) + '\n', { mode: 0o600 });
      made[name] = { file, xonly: xonlyOfPriv(priv), address: p2trAddress(xonlyOfPriv(priv), network) };
    }
    console.log(JSON.stringify(made, null, 2));
    console.log(`\nKeep ${out} offline-backed-up. gate + lock sign mints and sales; wallet is the hot wallet
(relay tickets and inscribe fees are paid to it; it holds the parent until mint-out).
Put gate.xonly / lock.xonly in launch/config.json as gateKey / lockKey.`);
  },

  art() {
    const [artistDir, outDir] = positional;
    if (!artistDir || !outDir) throw new Error('usage: art <artistDir> <outDir> --name "<collection name>" [--seed <hex>]');
    const args = [path.join(ROOT, 'vendor/shielded-ordinals/tools/prepare-art.mjs'), artistDir, outDir, '--name', need('--name')];
    if (flag('--seed')) args.push('--seed', flag('--seed'));
    process.stdout.write(execFileSync(process.execPath, args));
    console.log(`\nKeep ${outDir}/PRIVATE-shuffle.json private until mint-out. Copy artRoot + supply into launch/config.json.`);
  },

  rules() {
    const cfg = JSON.parse(fs.readFileSync(need('--config'), 'utf8'));
    const network = cfg.network ?? 'mainnet';
    const vkey = JSON.parse(fs.readFileSync(cfg.spendVkey, 'utf8'));
    if (/dev-ceremony/.test(cfg.spendVkey) && network === 'mainnet') throw new Error('refusing the dev ceremony key on mainnet: run the public ceremony first (docs/LAUNCH.md)');
    const script = (v) => (/^[0-9a-f]{64}$/.test(v) ? p2trScriptHex(v, network) : hex.encode(btc.OutScript.encode(btc.Address(NETWORKS[network]).decode(v))));
    const rules = {
      p: 'shord', v: 1, name: cfg.name, supply: cfg.supply,
      artRoot: cfg.artRoot, contentType: cfg.contentType, inscribeFee: cfg.inscribeFee,
      relayerPayoutScript: script(cfg.relayerPayout), mintPrice: cfg.mintPrice, artistPayoutScript: script(cfg.artistPayout),
      platformPayoutScript: script(cfg.platformPayout), mintFee: cfg.mintFee, saleFeeBps: cfg.saleFeeBps, saleFeeMin: cfg.saleFeeMin,
      ticketPrice: cfg.ticketPrice, gateKey: cfg.gateKey, lockKey: cfg.lockKey, spendVkeyHash: vkeyHash(vkey),
    };
    parseRules(rules); // throws on anything the indexer would refuse
    const text = JSON.stringify(rules);
    fs.writeFileSync(need('--out'), text + '\n');
    console.log(`rules OK (${text.length} bytes), spendVkeyHash ${rules.spendVkeyHash}\nwritten to ${flag('--out')}. Read it once more: it can never change after the parent is inscribed.`);
  },

  commit() {
    const network = need('--network');
    const rulesText = fs.readFileSync(need('--rules'), 'utf8').trim();
    parseRules(rulesText);
    const feeRate = Number(need('--fee-rate'));
    const grandparent = flag('--grandparent');
    const revealPriv = Buffer.from(schnorr.utils.randomSecretKey());
    const items = [{ contentType: 'application/json', body: Buffer.from(rulesText), ...(grandparent ? { parent: grandparent } : {}) }];
    const plan = planInscriptions({ network, revealPriv, items });
    const PARENT_VALUE = 10_000;
    const fakeOut = [{ script: numsScript(network), value: PARENT_VALUE }];
    const gp = grandparent ? { txid: '00'.repeat(32), vout: 0, value: 10_000, priv: Buffer.from(schnorr.utils.randomSecretKey()) } : null;
    const vsize = revealVsize({ network, plan, revealPriv, commit: { txid: '00'.repeat(32), vout: 0, value: 1_000_000 }, parent: gp, outputs: gp ? [{ script: numsScript(network), value: 10_000 }, ...fakeOut] : fakeOut });
    const amount = PARENT_VALUE + Math.ceil((vsize + 4) * feeRate);
    const planFile = path.join(path.dirname(flag('--rules')), 'parent-plan.json');
    fs.writeFileSync(planFile, JSON.stringify({ network, revealPriv: revealPriv.toString('hex'), rulesFile: path.resolve(flag('--rules')), grandparent: grandparent ?? null, amount, parentValue: PARENT_VALUE }, null, 1), { mode: 0o600 });
    console.log(`Send exactly ${amount} sats to\n\n  ${plan.commitAddress}\n\nthen: node tools/launch.mjs reveal --plan ${planFile} --commit <txid>:<vout> --to <platform wallet xonly or address>`);
    if (grandparent) console.log(`The reveal also spends the grandparent ${grandparent} and returns it, so the parent is its child.`);
  },

  reveal() {
    const plan = JSON.parse(fs.readFileSync(need('--plan'), 'utf8'));
    const network = plan.network;
    const rulesText = fs.readFileSync(plan.rulesFile, 'utf8').trim();
    const revealPriv = Buffer.from(plan.revealPriv, 'hex');
    const items = [{ contentType: 'application/json', body: Buffer.from(rulesText), ...(plan.grandparent ? { parent: plan.grandparent } : {}) }];
    const p = planInscriptions({ network, revealPriv, items });
    const c = outpoint(need('--commit'));
    const to = need('--to');
    const toScript = /^[0-9a-f]{64}$/.test(to) ? hex.decode(p2trScriptHex(to, network)) : btc.OutScript.encode(btc.Address(NETWORKS[network]).decode(to));
    let gp = null;
    const outputs = [];
    if (plan.grandparent) {
      const u = outpoint(need('--grandparent-utxo'));
      gp = { ...u, priv: Buffer.from(readKey(need('--grandparent-key')), 'hex') };
      outputs.push({ script: btc.p2tr(schnorr.getPublicKey(gp.priv), undefined, NETWORKS[network]).script, value: u.value });
    }
    outputs.push({ script: toScript, value: plan.parentValue });
    const r = revealTx({ network, plan: p, revealPriv, commit: { ...c, value: plan.amount }, parent: gp, outputs });
    const parentVout = gp ? 1 : 0;
    console.log(`reveal ${r.txid} (${r.vsize} vB)\n\n${r.hex}\n\nBroadcast it, then start the platform with:
  RULES_INSCRIPTION_ID=${r.txid}i0
  PARENT_OUTPOINT=${r.txid}:${parentVout}:${plan.parentValue}
  RULES_BLOCK=<hash of the block it confirms in>   START_HEIGHT=<that block's height>`);
  },

  park() {
    const network = need('--network');
    const parent = outpoint(need('--parent'));
    const fee = outpoint(need('--fee-coin'));
    const priv = Buffer.from(readKey(need('--wallet-key')), 'hex');
    const feeRate = Number(need('--fee-rate'));
    const pay = btc.p2tr(schnorr.getPublicKey(priv), undefined, NETWORKS[network]);
    const make = (f) => {
      const tx = new btc.Transaction();
      for (const u of [parent, fee]) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: pay.script, amount: BigInt(u.value) }, tapInternalKey: pay.tapInternalKey });
      tx.addOutput({ script: numsScript(network), amount: BigInt(parent.value) });
      const change = fee.value - f;
      if (change >= 330) tx.addOutput({ script: pay.script, amount: BigInt(change) });
      tx.sign(priv);
      tx.finalize();
      return tx;
    };
    const tx = make(Math.ceil(make(0).vsize * feeRate));
    console.log(`park ${tx.id}: the parent goes to NUMS (output 0), so the rules and supply are final.\n\n${hex.encode(tx.extract())}`);
  },
};

if (!commands[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(cmd ? 1 : 0);
}
try { commands[cmd](); } catch (e) { console.error(e.message); process.exit(1); }
