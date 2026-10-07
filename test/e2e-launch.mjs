// tools/launch.mjs end to end on regtest, including the official-DGC-child path:
//   a stand-in DGC parent -> keys -> rules -> commit -> reveal as a child of DGC -> platform starts
//   from the printed values and its indexer reads the rules from that parent.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as btc from '@scure/btc-signer';
import { readInscriptions } from '../vendor/shielded-ordinals/src/v1/inscribe.mjs';
import { planInscriptions, revealTx, NETWORKS } from '../packages/sdk/src/inscribe.mjs';
import { xonlyOfPriv } from '../packages/sdk/src/signers.mjs';
import { startPlatform } from '../services/platform/server.mjs';
import { startRegtest } from './lib/regtest.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA = path.join(ROOT, '.regtest', 'launch');
fs.rmSync(DATA, { recursive: true, force: true });
const rt = await startRegtest(path.join(DATA, 'node'));
const ok = (m) => console.log(`  ✓ ${m}`);
const net = NETWORKS.regtest;
const fundAddr = async (address, sats) => rt.fund(btc.OutScript.encode(btc.Address(net).decode(address)), sats);
const tool = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'tools/launch.mjs'), ...a], { cwd: ROOT }).toString();
let platform;
try {
  // a stand-in for the Decentralized Gentlemen Club parent, held by a key we control
  const dgcPriv = Buffer.from(schnorr.utils.randomSecretKey());
  fs.writeFileSync(path.join(DATA, 'dgc.json'), JSON.stringify({ priv: dgcPriv.toString('hex') }));
  const dgcHolder = btc.p2tr(schnorr.getPublicKey(dgcPriv), undefined, net);
  const rp = schnorr.utils.randomSecretKey();
  const plan = planInscriptions({ network: 'regtest', revealPriv: rp, items: [{ contentType: 'text/plain', body: Buffer.from('Decentralized Gentlemen Club (stand-in parent)') }] });
  const c = await fundAddr(plan.commitAddress, 20_000);
  const dgc = revealTx({ network: 'regtest', plan, revealPriv: rp, commit: c, outputs: [{ script: dgcHolder.script, value: 10_000 }] });
  await rt.send(dgc.hex);
  await rt.mine();
  const DGC = `${dgc.txid}i0`;
  ok(`stand-in DGC parent ${DGC.slice(0, 16)}…`);

  const secrets = path.join(DATA, 'secrets');
  tool('keys', '--network', 'regtest', '--out', secrets);
  const key = (n) => JSON.parse(fs.readFileSync(path.join(secrets, `${n}.json`), 'utf8')).priv;
  const x = (n) => xonlyOfPriv(key(n));
  const cfg = {
    network: 'regtest', name: 'Shielded Degents (launch test)', supply: 4, artRoot: 'ab'.repeat(32), contentType: 'image/png', inscribeFee: 3000,
    mintPrice: 50000, mintFee: 3500, saleFeeBps: 250, saleFeeMin: 1000, ticketPrice: 1500,
    relayerPayout: x('wallet'), artistPayout: x('wallet'), platformPayout: x('wallet'), gateKey: x('gate'), lockKey: x('lock'),
    spendVkey: path.join(ROOT, 'zk/dev-ceremony/spend/vkey.json'),
  };
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(cfg));
  tool('rules', '--config', path.join(DATA, 'config.json'), '--out', path.join(DATA, 'rules.json'));
  ok('keys + rules');

  const commitOut = tool('commit', '--rules', path.join(DATA, 'rules.json'), '--network', 'regtest', '--fee-rate', '2', '--grandparent', DGC);
  const amount = Number(commitOut.match(/exactly (\d+) sats/)[1]);
  const address = commitOut.match(/\n\s+(bcrt1\S+)/)[1];
  const commit = await fundAddr(address, amount);
  await rt.mine();
  const revealOut = tool('reveal', '--plan', path.join(DATA, 'parent-plan.json'), '--commit', `${commit.txid}:${commit.vout}`, '--to', x('wallet'),
    '--grandparent-utxo', `${dgc.txid}:0:10000`, '--grandparent-key', path.join(DATA, 'dgc.json'));
  const txid = await rt.send(revealOut.split('\n').find((l) => /^[0-9a-f]{200,}$/.test(l)));
  const [rulesBlock] = await rt.mine();
  const [ins] = readInscriptions(await rt.node('getrawtransaction', txid, false));
  assert.deepEqual(ins.parents, [DGC]);
  const tx = await rt.node('getrawtransaction', txid, true);
  assert.equal(tx.vout[0].scriptPubKey.hex, Buffer.from(dgcHolder.script).toString('hex'), 'the DGC parent is returned to its holder');
  ok(`rules parent ${ins.id.slice(0, 16)}… is a child of DGC; the DGC parent went back to its holder`);

  const env = Object.fromEntries([...revealOut.matchAll(/^\s+([A-Z_]+)=(\S+)/gm)].map((m) => [m[1], m[2]]));
  for (let i = 0; i < 2; i++) await rt.fund(btc.p2tr(Buffer.from(x('wallet'), 'hex'), undefined, net).script, 200_000);
  await rt.mine();
  platform = await startPlatform({
    network: 'regtest', rpc: rt.url, rpcCookie: rt.cookie, rulesInscriptionId: env.RULES_INSCRIPTION_ID, rulesBlock,
    startHeight: (await rt.node('getblock', rulesBlock)).height, parentOutpoint: env.PARENT_OUTPOINT,
    spendVkey: JSON.parse(fs.readFileSync(cfg.spendVkey, 'utf8')), gatePriv: key('gate'), lockPriv: key('lock'), walletPriv: key('wallet'),
    port: 0, stateFile: path.join(DATA, 'state.json'), cacheDir: path.join(DATA, 'cache'), loops: false, log: () => {},
  });
  assert.equal(platform.rules.name, cfg.name);
  assert.equal(platform.store.get().parent.vout, 1);
  ok('the platform starts from the printed values and reads the rules from chain');

  // park: the parent goes to NUMS for good
  const feeCoin = await rt.fund(btc.p2tr(Buffer.from(x('wallet'), 'hex'), undefined, net).script, 50_000);
  await rt.mine();
  const parkOut = tool('park', '--network', 'regtest', '--parent', `${txid}:1:10000`, '--wallet-key', path.join(secrets, 'wallet.json'),
    '--fee-coin', `${feeCoin.txid}:${feeCoin.vout}:${feeCoin.value}`, '--fee-rate', '2');
  const parkTxid = await rt.send(parkOut.split('\n').find((l) => /^[0-9a-f]{100,}$/.test(l)));
  await rt.mine();
  const parked = await rt.node('getrawtransaction', parkTxid, true);
  assert.equal(parked.vout[0].scriptPubKey.hex, Buffer.from(btc.p2tr(Buffer.from('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0', 'hex'), undefined, net).script).toString('hex'));
  ok('park: the parent now sits at NUMS, the rules are final');
  console.log('\nALL LAUNCH CHECKS PASSED');
} finally {
  await platform?.close();
  rt.stop();
}
