// Stand-ins for the remote services, backed by a regtest bitcoind, so the "no local node" setup can be
// tested end to end without real coins:
//   fakeGetBlock  a shared hosted node: RPC only at /<token>, no auth, wallet and scan calls refused
//   esploraShim   the mempool.space API routes the platform and the web vault use
import http from 'node:http';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';

const listen = (server, host = '127.0.0.1') => new Promise((ok) => server.listen(0, host, () => ok(server.address().port)));
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => ok(b)); });

const REFUSED = /^(createwallet|loadwallet|listwallets|importdescriptors|listunspent|getnewaddress|sendtoaddress|gettransaction|scantxoutset|generatetoaddress|getdescriptorinfo)$/;

export async function fakeGetBlock(rt, token = 'test-stub', host = '127.0.0.1') {
  const calls = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.method !== 'POST' || req.url !== `/${token}`) return send(404, { error: 'unknown token' });
    const msg = JSON.parse(await body(req));
    calls.set(msg.method, (calls.get(msg.method) ?? 0) + 1);
    if (REFUSED.test(msg.method)) return send(200, { result: null, error: { code: -32601, message: `${msg.method} is not available on shared nodes` }, id: msg.id });
    try { send(200, { result: await rt.node(msg.method, ...(msg.params ?? [])), error: null, id: msg.id }); } catch (e) { send(200, { result: null, error: { code: -1, message: e.message }, id: msg.id }); }
  });
  const port = await listen(server, host);
  return { url: `http://127.0.0.1:${port}/${token}`, port, token, calls, close: () => server.close() };
}

export async function esploraShim(rt) {
  const net = rt.NET;
  const prevScripts = async (tx) => Promise.all(tx.vin.map(async (v) => {
    if (v.coinbase) return null;
    const p = await rt.node('getrawtransaction', v.txid, true);
    return { scriptpubkey: p.vout[v.vout].scriptPubKey.hex, value: Math.round(p.vout[v.vout].value * 1e8) };
  }));
  async function utxos(address) {
    const script = bitcoin.address.toOutputScript(address, net).toString('hex');
    const confirmed = (await rt.node('scantxoutset', 'start', [`addr(${address})`])).unspents
      .map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8), status: { confirmed: true } }));
    const spent = new Set();
    const pending = [];
    for (const txid of await rt.node('getrawmempool')) {
      const tx = await rt.node('getrawtransaction', txid, true);
      for (const v of tx.vin) spent.add(`${v.txid}:${v.vout}`);
      tx.vout.forEach((o) => { if (o.scriptPubKey.hex === script) pending.push({ txid, vout: o.n, value: Math.round(o.value * 1e8), status: { confirmed: false } }); });
    }
    return [...confirmed, ...pending].filter((u) => !spent.has(`${u.txid}:${u.vout}`));
  }
  const routes = [
    [/^\/blocks\/tip\/height$/, async () => String(await rt.node('getblockcount'))],
    [/^\/block-height\/(\d+)$/, async (m) => rt.node('getblockhash', Number(m[1]))],
    [/^\/block\/([0-9a-f]{64})\/raw$/, async (m) => Buffer.from(await rt.node('getblock', m[1], 0), 'hex')],
    [/^\/address\/([^/]+)\/utxo$/, async (m) => utxos(m[1])],
    [/^\/v1\/fees\/recommended$/, async () => ({ fastestFee: 2, halfHourFee: 2, hourFee: 1, economyFee: 1, minimumFee: 1 })],
    [/^\/tx\/([0-9a-f]{64})\/hex$/, async (m) => rt.node('getrawtransaction', m[1], false)],
    [/^\/tx\/([0-9a-f]{64})\/status$/, async (m) => { const t = await rt.node('getrawtransaction', m[1], true); return { confirmed: (t.confirmations ?? 0) > 0 }; }],
    [/^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/, async (m) => ({ spent: (await rt.node('gettxout', m[1], Number(m[2]), true)) === null })],
    [/^\/tx\/([0-9a-f]{64})$/, async (m) => { const t = await rt.node('getrawtransaction', m[1], true); const p = await prevScripts(t); return { txid: t.txid, vin: t.vin.map((v, i) => ({ ...v, prevout: p[i] })), status: { confirmed: (t.confirmations ?? 0) > 0 } }; }],
  ];
  const server = http.createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': '*' };
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'POST' && url.pathname === '/tx') {
        const txid = await rt.node('sendrawtransaction', (await body(req)).trim(), 0);
        res.writeHead(200, { ...cors, 'content-type': 'text/plain' }); return res.end(txid);
      }
      for (const [re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m || req.method !== 'GET') continue;
        const out = await fn(m);
        if (Buffer.isBuffer(out)) { res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' }); return res.end(out); }
        if (typeof out === 'string') { res.writeHead(200, { ...cors, 'content-type': 'text/plain' }); return res.end(out); }
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify(out));
      }
      res.writeHead(404, cors); res.end('not found');
    } catch (e) {
      res.writeHead(/not found|No such/i.test(e.message) ? 404 : 400, { ...cors, 'content-type': 'text/plain' }); res.end(e.message);
    }
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, port, utxos, close: () => server.close() };
}
