// The whole ecosystem on your machine, on a private regtest chain:
//   bitcoind (regtest) -> collection launched (placeholder Degent art) -> platform service (all loops on)
//   -> web vault on http://localhost:8790 with a built-in dev wallet and faucet. Blocks are mined
//   automatically whenever something is waiting in the mempool.
//
//   npm run dev        (Ctrl+C stops everything; state is thrown away)
//   docker compose up  (the same, in containers: see docker-compose.yml)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRegtest, connectRegtest } from '../test/lib/regtest.mjs';
import { launchCollection } from '../test/lib/launch.mjs';
import { startPlatform } from '../services/platform/server.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA = path.join(ROOT, '.regtest', 'dev');
const PLATFORM_PORT = Number(process.env.PLATFORM_PORT ?? 5030);
const WEB_PORT = Number(process.env.WEB_PORT ?? 8790);
const vkey = JSON.parse(fs.readFileSync(path.join(ROOT, 'zk/dev-ceremony/spend/vkey.json'), 'utf8'));
const newPriv = () => Buffer.from(schnorr.utils.randomSecretKey()).toString('hex');

fs.rmSync(DATA, { recursive: true, force: true });
// BITCOIN_RPC=http://user:pass@host:port uses a node that is already running (docker compose);
// otherwise a throwaway bitcoind is started from PATH
const rt = process.env.BITCOIN_RPC
  ? (console.log(`using bitcoind at ${new URL(process.env.BITCOIN_RPC).host}…`), await connectRegtest(process.env.BITCOIN_RPC))
  : (console.log('starting bitcoind (regtest)…'), await startRegtest(path.join(DATA, 'node')));
const keys = { gatePriv: newPriv(), lockPriv: newPriv(), walletPriv: newPriv() };
const L = await launchCollection(rt, { dir: DATA, supply: Number(process.env.SUPPLY ?? 48), name: 'Shielded Degents', keys, vkey });
console.log(`collection launched: ${L.rulesInscriptionId}`);

// same input checks as the platform's own dev routes: a bad address is a 400, not a 500 or `addr(null)`
const scriptOf = (address) => {
  try { return bitcoin.address.toOutputScript(address, rt.NET); } catch { throw Object.assign(new Error('not a valid address for this network'), { status: 400 }); }
};
const dev = {
  'POST /dev/faucet': async (_q, body) => {
    const script = scriptOf(body?.address);
    const coin = await rt.fund(script, Math.min(Number(body.sats ?? 1_000_000), 100_000_000));
    await rt.mine();
    return coin;
  },
  'GET /dev/utxos': async (q) => {
    scriptOf(q.get('address'));
    const r = await rt.node('scantxoutset', 'start', [`addr(${q.get('address')})`]);
    return { utxos: r.unspents.map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8) })) };
  },
  'POST /dev/mine': async (_q, body) => ({ blocks: await rt.mine(Math.min(Number(body.blocks ?? 1), 2000)) }),
};
const platform = await startPlatform({
  network: 'regtest', rpc: rt.url, rpcCookie: rt.cookie, ...L, spendVkey: vkey, ...keys, port: PLATFORM_PORT,
  stateFile: path.join(DATA, 'platform-state.json'), cacheDir: path.join(DATA, 'cache'),
  gatePool: 5, syncMs: 1000, batchMs: 6000, inscribeMs: 5000, extraRoutes: dev,
});
await platform.tasks.gates();
await rt.mine();

// mine whenever the mempool has something, so the dev loop feels like a fast chain
setInterval(async () => {
  try { if ((await rt.node('getmempoolinfo')).size > 0) await rt.mine(); } catch { /* node stopping */ }
}, 3000).unref();

const cfgFile = path.join(DATA, 'web-config.json');
fs.writeFileSync(cfgFile, JSON.stringify({ network: 'regtest', platformUrl: process.env.PUBLIC_PLATFORM_URL ?? `http://localhost:${PLATFORM_PORT}`, esploraUrl: null, artBase: 'platform', pieceName: 'Shielded Degent', pollMs: 2000 }, null, 2));
const web = spawn(process.execPath, [path.join(ROOT, 'apps/web/build.mjs'), '--serve'], { env: { ...process.env, CONFIG: cfgFile, PORT: String(WEB_PORT) }, stdio: 'inherit' });

const stop = async () => { web.kill(); await platform.close(); rt.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`\nplatform  http://localhost:${PLATFORM_PORT}/status\nweb vault http://localhost:${WEB_PORT}\n(Ctrl+C to stop)`);
