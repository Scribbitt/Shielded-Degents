// A throwaway regtest bitcoind for tests: start, fund coins to any script, mine, stop.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { makeRpc } from '../../vendor/shielded-ordinals/src/v1/follow.mjs';

export async function startRegtest(dataDir) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn('bitcoind', [
    '-regtest', `-datadir=${dataDir}`, `-rpcport=${port}`, `-port=${port + 1}`, '-listen=0', '-server', '-txindex=1',
    '-fallbackfee=0.0002', '-datacarriersize=100000', '-acceptnonstdtxn=1', '-printtoconsole=0',
  ], { stdio: 'ignore' });
  const cookie = path.join(dataDir, 'regtest', '.cookie');
  const url = `http://127.0.0.1:${port}`;
  const node = makeRpc(url, cookie);
  const wallet = makeRpc(`${url}/wallet/funder`, cookie);
  for (let i = 0; ; i++) {
    try { if (fs.existsSync(cookie)) { await node('getblockcount'); break; } } catch { /* starting */ }
    if (i > 150) throw new Error('bitcoind did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  await node('createwallet', 'funder');
  const minerAddr = await wallet('getnewaddress', '', 'bech32m');
  const NET = bitcoin.networks.regtest;
  const rt = {
    url, cookie, node, wallet, NET,
    mine: (n = 1) => wallet('generatetoaddress', n, minerAddr),
    async fund(script, sats) {
      const address = bitcoin.address.fromOutputScript(Buffer.from(script), NET);
      const txid = await wallet('sendtoaddress', address, sats / 1e8);
      const hex = (await wallet('gettransaction', txid)).hex;
      const vout = (await node('decoderawtransaction', hex)).vout.find((o) => o.scriptPubKey.hex === Buffer.from(script).toString('hex')).n;
      return { txid, vout, value: sats, script: Buffer.from(script) };
    },
    send: (hex) => node('sendrawtransaction', hex, 0),
    stop: () => { try { proc.kill('SIGTERM'); } catch { /* gone */ } },
  };
  process.on('exit', rt.stop);
  await rt.mine(101);
  return rt;
}

/**
 * Use a regtest bitcoind that is already running (e.g. the docker compose `bitcoind` service).
 * url = http://user:pass@host:port. Same shape as startRegtest; stop() leaves the node running.
 */
export async function connectRegtest(url) {
  const node = makeRpc(url);
  const wallet = makeRpc(`${url.replace(/\/+$/, '')}/wallet/funder`);
  for (let i = 0; ; i++) {
    try { await node('getblockcount'); break; } catch (e) { if (i > 150) throw new Error(`bitcoind at ${new URL(url).host} is not answering: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!(await node('listwallets')).includes('funder')) {
    try { await node('loadwallet', 'funder'); } catch { await node('createwallet', 'funder'); }
  }
  const minerAddr = await wallet('getnewaddress', '', 'bech32m');
  const NET = bitcoin.networks.regtest;
  const rt = {
    url, cookie: null, node, wallet, NET,
    mine: (n = 1) => wallet('generatetoaddress', n, minerAddr),
    async fund(script, sats) {
      const address = bitcoin.address.fromOutputScript(Buffer.from(script), NET);
      const txid = await wallet('sendtoaddress', address, sats / 1e8);
      const hex = (await wallet('gettransaction', txid)).hex;
      const vout = (await node('decoderawtransaction', hex)).vout.find((o) => o.scriptPubKey.hex === Buffer.from(script).toString('hex')).n;
      return { txid, vout, value: sats, script: Buffer.from(script) };
    },
    send: (hex) => node('sendrawtransaction', hex, 0),
    stop: () => {},
  };
  if ((await node('getblockcount')) < 101) await rt.mine(101);
  return rt;
}
