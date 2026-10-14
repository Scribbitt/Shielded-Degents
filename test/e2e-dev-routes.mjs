// The dev-only platform routes (GET /dev/utxos, POST /dev/faucet) on a private regtest node:
// input validation, the per-address scan throttle, and the faucet's cooldown + hourly cap.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startPlatform } from '../services/platform/server.mjs';
import { xonlyOfPriv } from '../packages/sdk/src/signers.mjs';
import { startRegtest } from './lib/regtest.mjs';
import { launchCollection } from './lib/launch.mjs';

bitcoin.initEccLib(ecc);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const vkey = JSON.parse(fs.readFileSync(ROOT + 'zk/dev-ceremony/spend/vkey.json', 'utf8'));
const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);
const newPriv = () => Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');

const DATA = path.join(ROOT, '.regtest', 'dev-routes');
fs.rmSync(DATA, { recursive: true, force: true });
const rt = await startRegtest(path.join(DATA, 'node'));
const keys = { gatePriv: newPriv(), lockPriv: newPriv(), walletPriv: newPriv() };
const L = await launchCollection(rt, { dir: DATA, supply: 4, keys, vkey });
const freshAddress = () => bitcoin.payments.p2tr({ internalPubkey: Buffer.from(xonlyOfPriv(newPriv()), 'hex'), network: rt.NET }).address;

process.env.FAUCET_WALLET = 'funder';
const start = (name, extra) => startPlatform({
  network: 'regtest', rpc: rt.url, rpcCookie: rt.cookie, ...L, spendVkey: vkey, ...keys, gatePool: 1, port: 0,
  stateFile: path.join(DATA, `${name}-state.json`), cacheDir: path.join(DATA, `${name}-cache`), loops: false, log: () => {}, ...extra,
});
const call = (p, method, route, body) => fetch(`http://127.0.0.1:${p.port}${route}`, {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));
const utxos = (p, address) => call(p, 'GET', `/dev/utxos${address === undefined ? '' : `?address=${encodeURIComponent(address)}`}`);
const faucet = (p, body) => call(p, 'POST', '/dev/faucet', body);

const open = await start('open', {});
const limited = await start('limited', { faucetLimit: true });
try {
  step('GET /dev/utxos: validation and throttle');
  for (const bad of [undefined, '', 'null', ')', 'x'.repeat(200), 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx']) {
    const r = await utxos(open, bad);
    assert.equal(r.status, 400, `address ${JSON.stringify(bad)}: ${JSON.stringify(r.body)}`);
  }
  ok('a missing, malformed or wrong-network address is a 400, not a 500');
  const addr = freshAddress();
  assert.deepEqual((await utxos(open, addr)).body, { utxos: [] });
  ok('an address with no coins returns an empty list');
  const again = await utxos(open, addr);
  assert.equal(again.status, 429);
  ok('a second scan of the same address within 2 s is a 429');
  assert.equal((await utxos(open, addr.toUpperCase())).status, 429);
  ok('the same address in upper case is the same address for the throttle');
  const coin = await rt.fund(bitcoin.address.toOutputScript(addr, rt.NET), 123_456);
  await rt.mine();
  await new Promise((r) => setTimeout(r, 2100));
  const after = await utxos(open, addr);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.utxos, [{ txid: coin.txid, vout: coin.vout, value: 123_456 }]);
  ok('after the throttle window the funded coin is listed');

  step('POST /dev/faucet: validation');
  for (const [body, why] of [
    [undefined, 'no body'], [{}, 'no address'], [{ address: 'nope' }, 'bad address'],
    [{ address: freshAddress(), sats: 'abc' }, 'sats not a number'], [{ address: freshAddress(), sats: '5000' }, 'sats a string'],
    [{ address: freshAddress(), sats: -5 }, 'negative sats'], [{ address: freshAddress(), sats: 0 }, 'zero sats'],
    [{ address: freshAddress(), sats: 1500.5 }, 'fractional sats'], [{ address: freshAddress(), sats: 999 }, 'below the minimum'],
  ]) {
    const r = await faucet(open, body);
    assert.equal(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
  }
  ok('bad bodies are 400s');
  const to = freshAddress();
  const big = await faucet(open, { address: to, sats: 999_000_000 });
  assert.equal(big.status, 200);
  assert.equal(big.body.sats, 10_000_000);
  ok('an oversized request is capped at 10,000,000 sats');
  delete process.env.FAUCET_WALLET;
  const noWallet = await faucet(open, { address: freshAddress() });
  assert.equal(noWallet.status, 501);
  process.env.FAUCET_WALLET = 'funder';
  ok('no FAUCET_WALLET is a 501');

  step('POST /dev/faucet: unlimited on regtest');
  const same = freshAddress();
  assert.equal((await faucet(open, { address: same })).status, 200);
  assert.equal((await faucet(open, { address: same })).status, 200);
  ok('the same address can ask twice');

  step('POST /dev/faucet: cooldown and hourly cap when limited');
  const a = freshAddress(), b = freshAddress();
  const first = await faucet(limited, { address: a, sats: 2_000_000 });
  assert.equal(first.status, 200);
  const second = await faucet(limited, { address: a, sats: 2_000_000 });
  assert.equal(second.status, 429);
  ok('a second drip to the same address is a 429');
  assert.equal((await faucet(limited, { address: a.toUpperCase(), sats: 2_000_000 })).status, 429);
  ok('the same address in upper case does not get a second drip');
  assert.equal((await faucet(limited, { address: b, sats: 2_000_000 })).status, 200);
  ok('a different address still gets coins');
  await rt.mine();
  const seen = (await rt.node('scantxoutset', 'start', [`addr(${a})`])).unspents.map((u) => Math.round(u.amount * 1e8));
  assert.deepEqual(seen, [2_000_000]);
  ok('the first drip really arrived, and only once');

  process.env.FAUCET_HOURLY_SATS = '3000000';
  const tight = await start('tight', { faucetLimit: true });
  delete process.env.FAUCET_HOURLY_SATS;
  assert.equal((await faucet(tight, { address: freshAddress(), sats: 2_000_000 })).status, 200);
  const over = await faucet(tight, { address: freshAddress(), sats: 2_000_000 });
  assert.equal(over.status, 429);
  assert.equal((await faucet(tight, { address: freshAddress(), sats: 1_000_000 })).status, 200);
  ok('the hourly cap refuses a drip that would pass it, and a smaller one still fits');
  await tight.close?.();

  step('startup: limits that are not numbers are refused');
  for (const [k, v] of [['FAUCET_HOURLY_SATS', '50_000_000'], ['FAUCET_COOLDOWN_MS', 'soon'], ['FAUCET_COOLDOWN_MS', '-1']]) {
    process.env[k] = v;
    await assert.rejects(start(`bad-${k}`, { faucetLimit: true }), new RegExp(k));
    delete process.env[k];
  }
  ok('a NaN or negative FAUCET_* setting stops the platform instead of turning the limit off');

  step('extraRoutes: dev helpers can be replaced, core routes cannot');
  const host = await start('host', { extraRoutes: {
    'GET /dev/utxos': async () => ({ utxos: 'host' }),
    'GET /fees': async () => ({ feeRate: 'host' }),
    'GET /dev/extra': async () => ({ extra: true }),
  } });
  assert.equal((await utxos(host, freshAddress())).body.utxos, 'host');
  assert.notEqual((await call(host, 'GET', '/fees')).body.feeRate, 'host');
  assert.deepEqual((await call(host, 'GET', '/dev/extra')).body, { extra: true });
  ok("a host's /dev/* route wins, a core route keeps the platform's handler, new routes still work");
  await host.close?.();

  console.log('\nALL DEV ROUTE CHECKS PASSED');
} finally {
  await open.close?.();
  await limited.close?.();
  await rt.stop?.();
}
