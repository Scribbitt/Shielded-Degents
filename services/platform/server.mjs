// Shielded Degents platform service: the operator side of a single-key SHORD v1 collection.
//
//   indexer   follows Bitcoin with the vendor indexer (your node over RPC, or an esplora API)
//   signer    approves mints (gate coin) and buys / cancels (listing lock) after checking them
//   gates     keeps a pool of gate coins; every mint returns its gate coin, so the pool refills
//   relayer   batches relayed sends / listings / claims and publishes them from the hot wallet
//   inscriber inscribes each minted piece as a child of the parent, parked at NUMS
//
// Read routes have the same shape as the reference indexer API (vendor docs/API.md), so the web app
// can read from any indexer and only needs this service for the actions that need the platform.
//
// Config (env):
//   NETWORK=mainnet|signet|regtest
//   BITCOIN_RPC=http://user:pass@127.0.0.1:8332 [BITCOIN_RPC_COOKIE=...]   blocks (+ wallet, if no API)
//   MEMPOOL_API=https://mempool.space/signet/api   hot-wallet coins, fees, broadcast (+ blocks, if no RPC)
//   Both set = blocks from the node (e.g. GetBlock through docker/btc-proxy), wallet I/O from the API.
//   RULES_INSCRIPTION_ID=<parent>i0  RULES_BLOCK=<hash of its block>  START_HEIGHT=<height>
//   SPEND_VKEY=zk/.../vkey.json   (must match rules.spendVkeyHash)
//   GATE_KEY_HEX / LOCK_KEY_HEX / WALLET_KEY_HEX   (or *_FILE pointing at {"priv":"<hex>"})
//   PARENT_OUTPOINT=<txid>:<vout>:<value>   where the parent sits (first run only; then persisted)
//   [ART_DIR=launch/art]  [GATE_POOL=5] [GATE_VALUE=600] [PORT=5030] [STATE_FILE=.platform-state.json]
//   [CACHE_DIR=.cache-platform] [SYNC_MS=15000] [BATCH_MS=600000] [INSCRIBE_MS=60000] [CORS_ORIGIN=*]
//   [FAUCET_WALLET=<node wallet>] [FAUCET_COOLDOWN_MS=3600000] [FAUCET_HOURLY_SATS=50000000]   dev faucet, non-mainnet with BITCOIN_RPC
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { follower, loadRules, makeSource, makeRpc } from '../../vendor/shielded-ordinals/src/v1/follow.mjs';
import { exportState } from '../../vendor/shielded-ordinals/src/v1/view.mjs';
import { collectionId, saleFee, vkeyHash } from '../../vendor/shielded-ordinals/src/v1/rules.mjs';
import { parseEnvelope, T } from '../../vendor/shielded-ordinals/src/v1/envelope.mjs';
import { PlatformSigner } from '../../packages/platform/src/policy.mjs';
import { chainIO } from '../../packages/platform/src/chain-io.mjs';
import { HotWallet } from '../../packages/platform/src/hot-wallet.mjs';
import { inscriber as makeInscriber } from '../../packages/platform/src/inscriber.mjs';
import { relayQueue } from '../../packages/platform/src/relay.mjs';
import { cancelPsbt } from '../../packages/sdk/src/txs.mjs';

const env = (k, d) => { const v = process.env[k]?.trim(); if (v) return v; if (d !== undefined) return d; throw new Error(`missing ${k}`); };
const secret = (k) => process.env[`${k}_HEX`]?.trim() || JSON.parse(fs.readFileSync(env(`${k}_FILE`).replace(/^~/, os.homedir()), 'utf8')).priv;

export async function startPlatform(cfg = {}) {
  const c = {
    network: cfg.network ?? env('NETWORK', 'signet'),
    rpc: cfg.rpc ?? process.env.BITCOIN_RPC?.trim(),
    rpcCookie: cfg.rpcCookie ?? process.env.BITCOIN_RPC_COOKIE?.trim(),
    api: cfg.api ?? process.env.MEMPOOL_API?.trim(),
    rulesInscriptionId: cfg.rulesInscriptionId ?? env('RULES_INSCRIPTION_ID'),
    rulesBlock: cfg.rulesBlock ?? process.env.RULES_BLOCK?.trim(),
    startHeight: cfg.startHeight ?? Number(env('START_HEIGHT')),
    spendVkey: cfg.spendVkey ?? JSON.parse(fs.readFileSync(env('SPEND_VKEY'), 'utf8')),
    gatePriv: cfg.gatePriv ?? secret('GATE_KEY'),
    lockPriv: cfg.lockPriv ?? secret('LOCK_KEY'),
    walletPriv: cfg.walletPriv ?? secret('WALLET_KEY'),
    parentOutpoint: cfg.parentOutpoint ?? process.env.PARENT_OUTPOINT?.trim(),
    artDir: cfg.artDir ?? process.env.ART_DIR?.trim(),
    gatePool: cfg.gatePool ?? Number(env('GATE_POOL', '5')),
    gateValue: cfg.gateValue ?? Number(env('GATE_VALUE', '600')),
    port: cfg.port ?? Number(env('PORT', '5030')),
    stateFile: cfg.stateFile ?? env('STATE_FILE', '.platform-state.json'),
    cacheDir: cfg.cacheDir ?? env('CACHE_DIR', '.cache-platform'),
    syncMs: cfg.syncMs ?? Number(env('SYNC_MS', '15000')),
    batchMs: cfg.batchMs ?? Number(env('BATCH_MS', '600000')),
    inscribeMs: cfg.inscribeMs ?? Number(env('INSCRIBE_MS', '60000')),
    cors: cfg.cors ?? env('CORS_ORIGIN', '*'),
    loops: cfg.loops ?? true,
    extraRoutes: cfg.extraRoutes ?? {},
    faucetLimit: cfg.faucetLimit ?? (cfg.network ?? env('NETWORK', 'signet')) !== 'regtest',
    log: cfg.log ?? console.log,
  };
  const NET = c.network === 'mainnet' ? bitcoin.networks.bitcoin : c.network === 'regtest' ? bitcoin.networks.regtest : bitcoin.networks.testnet;

  // ─── state on disk ─────────────────────────────────────────────────────────────────────────
  let saved = (() => { try { return JSON.parse(fs.readFileSync(c.stateFile, 'utf8')); } catch { return {}; } })();
  const store = {
    get: () => saved,
    set(patch) { saved = { ...saved, ...patch }; fs.writeFileSync(c.stateFile + '.tmp', JSON.stringify(saved, null, 1)); fs.renameSync(c.stateFile + '.tmp', c.stateFile); },
  };
  if (!saved.parent && c.parentOutpoint) {
    const [txid, vout, value] = c.parentOutpoint.split(':');
    store.set({ parent: { txid, vout: Number(vout), value: Number(value) } });
  }

  // ─── chain, rules, indexer ─────────────────────────────────────────────────────────────────
  const source = makeSource({ rpc: c.rpc, rpcCookie: c.rpcCookie, api: c.api });
  const rules = await loadRules({ source, rulesInscriptionId: c.rulesInscriptionId, rulesBlock: c.rulesBlock });
  if (rules.spendVkeyHash && vkeyHash(c.spendVkey) !== rules.spendVkeyHash) throw new Error('SPEND_VKEY is not the key the parent pins');
  const chain = follower({ network: c.network, source, cacheDir: c.cacheDir, rulesInscriptionId: c.rulesInscriptionId, rules, vkey: c.spendVkey, startHeight: c.startHeight });
  // blocks come from BITCOIN_RPC when set (your node, or a hosted node through btc-proxy), else the API;
  // the hot wallet's coins + broadcast use the API when set: hosted nodes refuse wallet calls
  const walletViaRpc = c.rpc && (!c.api || process.env.WALLET_VIA_RPC === 'true');
  const io = chainIO(walletViaRpc ? { rpc: c.rpc, rpcCookie: c.rpcCookie } : { api: c.api });
  const signer = new PlatformSigner({ rules, network: NET, gatePriv: c.gatePriv, lockPriv: c.lockPriv });
  const wallet = new HotWallet({ priv: c.walletPriv, network: NET, io });
  if (saved.parent) wallet.protected.add(`${saved.parent.txid}:${saved.parent.vout}`);
  const gateAddress = bitcoin.address.fromOutputScript(signer.gate, NET);
  await io.watch([wallet.address, gateAddress]);
  const relay = relayQueue({ rules, network: NET, wallet, io, store });
  const ins = c.artDir ? makeInscriber({ network: NET, networkName: c.network, rules, rulesInscriptionId: c.rulesInscriptionId, artDir: c.artDir, wallet, io, store }) : null;

  // ─── gate coins ────────────────────────────────────────────────────────────────────────────
  const reservations = new Map(); // "txid:vout" -> expiry ms
  async function freeGates() {
    const now = Date.now();
    for (const [k, t] of reservations) if (t < now) reservations.delete(k);
    return (await io.utxos(gateAddress)).filter((u) => !reservations.has(`${u.txid}:${u.vout}`));
  }
  async function topUpGates() {
    const free = await freeGates();
    const missing = c.gatePool - free.length;
    if (missing <= 0) return null;
    const tx = await wallet.pay({ outputs: Array.from({ length: missing }, () => ({ script: signer.gate, value: c.gateValue })), feeRate: await io.feeRate() });
    await io.broadcast(tx.hex);
    c.log(`gate pool: +${missing} (${tx.txid})`);
    return tx.txid;
  }

  // ─── actions ───────────────────────────────────────────────────────────────────────────────
  const fresh = async () => { await chain.sync(); return chain.fresh(); };

  async function reserveGate() {
    const free = await freeGates();
    if (!free.length) { await topUpGates().catch(() => {}); throw Object.assign(new Error('no gate coin free right now, try again in a moment'), { status: 503 }); }
    const g = free[Math.floor(Math.random() * free.length)];
    const expiresAt = Date.now() + 5 * 60_000;
    reservations.set(`${g.txid}:${g.vout}`, expiresAt);
    return { gate: { txid: g.txid, vout: g.vout, value: g.value }, gateKey: rules.gateKey, expiresAt };
  }

  async function sign(psbtB64) {
    const psbt = bitcoin.Psbt.fromBase64(psbtB64, { network: NET });
    const r = await signer.review(await fresh(), psbt);
    if (!r.ok) throw Object.assign(new Error(r.reason), { status: 400 });
    return { psbt: r.psbt.toBase64(), kind: r.kind, txid: r.txid };
  }

  async function cancel(claimHex) {
    const env = parseEnvelope(Buffer.from(String(claimHex), 'hex'));
    if (!env || env.type !== T.CLAIM || !env.cid.equals(collectionId(c.rulesInscriptionId))) throw Object.assign(new Error('not a CLAIM for this collection'), { status: 400 });
    const ix = await fresh();
    const l = ix.listings.get(env.listingNf);
    if (!l || l.state !== 'ACTIVE') throw Object.assign(new Error('listing is not active'), { status: 400 });
    const listing = { returnKey: l.returnKey.toString('hex'), lock: l.lock };
    const psbt = cancelPsbt({ rules, network: NET, listing, claim: { data: Buffer.from(claimHex, 'hex') }, funding: await wallet.coins(), changeScript: wallet.script, feeRate: await io.feeRate() }).psbt;
    const r = await signer.review(ix, psbt);
    if (!r.ok) throw Object.assign(new Error(r.reason), { status: 400 });
    wallet.signOwn(psbt);
    psbt.finalizeAllInputs();
    return { txid: await io.broadcast(psbt.extractTransaction().toHex()) };
  }

  async function broadcast(hex) {
    const tx = bitcoin.Transaction.fromHex(hex);
    for (const i of tx.ins) reservations.delete(`${Buffer.from(i.hash).reverse().toString('hex')}:${i.index}`);
    const txid = await io.broadcast(hex);
    pendingSigned.set(txid, Date.now());
    return { txid };
  }
  const pendingSigned = new Map();

  // ─── read API (vendor indexer shapes) ──────────────────────────────────────────────────────
  const publicRules = () => Object.fromEntries(Object.entries(rules).filter(([k]) => !['artistScript', 'platformScript', 'relayerScript'].includes(k)));
  const routes = {
    'GET /status': async () => {
      const ix = chain.ix();
      return { network: c.network, collection: rules.name, rulesInscriptionId: c.rulesInscriptionId, lastHeight: ix?.lastHeight ?? null, notes: ix?.notes.length ?? 0,
        digest: ix ? (await import('node:crypto')).createHash('sha256').update(ix.stateDigest()).digest('hex') : null, software: 'shielded-degents platform',
        relayer: { address: wallet.address, queued: relay.queued() }, gates: (await freeGates()).length, inscribed: Object.keys(saved.inscribed ?? {}).length };
    },
    'GET /collection': async () => {
      const ix = await fresh();
      return { rulesInscriptionId: c.rulesInscriptionId, cid: collectionId(c.rulesInscriptionId).toString('hex'), rules: publicRules(), minted: ix.minted.size, lastHeight: ix.lastHeight };
    },
    'GET /listings': async () => {
      const ix = await fresh();
      return [...ix.listings.values()].filter((l) => l.state === 'ACTIVE').map((l) => ({
        nf: String(l.nf), assetId: l.assetId, inscriptionId: saved.inscribed?.[l.assetId] ?? null, price: String(l.price),
        saleFee: String(saleFee(rules, l.price)), tickets: l.tickets, listedAt: l.height,
      }));
    },
    'GET /state': async (q) => exportState(await fresh(), { sinceNote: Number(q.get('since') ?? 0) }),
    'GET /inscriptions': async () => saved.inscribed ?? {},
    'GET /fees': async () => ({ feeRate: await io.feeRate() }),
    'POST /mint/reserve': async () => reserveGate(),
    'POST /sign': async (_q, body) => sign(body.psbt),
    'POST /broadcast': async (_q, body) => broadcast(body.hex),
    'POST /cancel': async (_q, body) => cancel(body.claimHex),
    'POST /relay': async (_q, body) => relay.submit(await fresh(), body.envelopeHex),
  };
  if (c.network !== 'mainnet' && c.rpc) {
    const rpcNode = makeRpc(c.rpc, c.rpcCookie);
    const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
    const checkAddress = (address) => {
      if (typeof address !== 'string' || address.length > 100) throw bad('address required');
      try { bitcoin.address.toOutputScript(address, NET); } catch { throw bad('not a valid address for this network'); }
      return address;
    };
    // scantxoutset locks the node while it scans the whole UTXO set: one scan per address every few seconds
    const scanned = new Map();
    routes['GET /dev/utxos'] = async (q) => {
      const address = checkAddress(q.get('address'));
      if (Date.now() - (scanned.get(address) ?? 0) < 2_000) throw bad('slow down', 429);
      scanned.set(address, Date.now());
      if (scanned.size > 1000) for (const [a, t] of scanned) if (Date.now() - t > 60_000) scanned.delete(a);
      const r = await rpcNode('scantxoutset', 'start', [`addr(${address})`]);
      return { utxos: (r?.unspents ?? []).map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8) })) };
    };
    // public networks: one drip per address per FAUCET_COOLDOWN_MS, and a global cap per hour (regtest is unlimited unless faucetLimit is set)
    const cooldownMs = Number(env('FAUCET_COOLDOWN_MS', '3600000'));
    const hourlyCap = Number(env('FAUCET_HOURLY_SATS', '50000000'));
    const dripped = new Map();
    const hour = [];
    routes['POST /dev/faucet'] = async (_q, body) => {
      const faucetWallet = process.env.FAUCET_WALLET;
      if (!faucetWallet) throw bad('FAUCET_WALLET not set', 501);
      const address = checkAddress(body?.address);
      const want = body?.sats ?? 1_000_000;
      if (!Number.isInteger(want) || want < 1000) throw bad('sats must be an integer of at least 1000');
      const sats = Math.min(want, 10_000_000);
      if (c.faucetLimit) {
        const now = Date.now();
        while (hour.length && now - hour[0].at > 3_600_000) hour.shift();
        if (now - (dripped.get(address) ?? 0) < cooldownMs) throw bad('this address already got coins recently', 429);
        if (hour.reduce((n, d) => n + d.sats, 0) + sats > hourlyCap) throw bad('the faucet is dry for now, try later', 429);
        dripped.set(address, now);
        hour.push({ at: now, sats });
      }
      const walletRpc = makeRpc(`${c.rpc.replace(/\/$/, '')}/wallet/${encodeURIComponent(faucetWallet)}`, c.rpcCookie);
      // pass fee_rate=1 sat/vB explicitly — node may lack fee estimates on a fresh chain
      let txid;
      try { txid = await walletRpc('sendtoaddress', address, sats / 1e8, '', '', false, null, null, 'unset', null, 1); } catch (e) { dripped.delete(address); hour.pop(); throw e; }
      return { txid, sats };
    };
  }

  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': c.cors, 'cache-control': 'no-store' });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
  };
  const artFiles = c.artDir ? new Map(fs.readdirSync(c.artDir).filter((f) => /^\d+\.[a-z0-9]+$/i.test(f)).map((f) => [Number(f.split('.')[0]), f])) : new Map();
  function serveArt(res, id) {
    const f = artFiles.get(id);
    if (!f || !chain.ix()?.minted.has(id)) return send(res, 404, { error: 'not minted' });
    res.writeHead(200, { 'content-type': rules.contentType, 'access-control-allow-origin': c.cors, 'cache-control': 'public, max-age=31536000, immutable' });
    res.end(fs.readFileSync(`${c.artDir}/${f}`));
  }
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': c.cors, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST' }); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const relayId = url.pathname.match(/^\/relay\/([0-9a-f-]{36})$/);
    const artId = url.pathname.match(/^\/art\/(\d+)$/);
    // art is public once a piece is minted; before that the shuffle stays private
    if (req.method === 'GET' && artId) return serveArt(res, Number(artId[1]));
    const txm = url.pathname.match(/^\/tx\/([0-9a-f]{64})$/);
    const utxom = url.pathname.match(/^\/utxo\/([0-9a-f]{64})\/(\d+)$/);
    if (req.method === 'GET' && (txm || utxom)) {
      const p = txm ? io.rawTx(txm[1]).then((hex) => ({ hex })) : io.isUnspent(utxom[1], Number(utxom[2])).then((unspent) => ({ unspent }));
      return p.then((b) => send(res, 200, b), (e) => send(res, 404, { error: e.message }));
    }
    if (req.method === 'GET' && relayId) { const s = relay.status(relayId[1]); return s ? send(res, 200, s) : send(res, 404, { error: 'unknown relay id' }); }
    const handler = c.extraRoutes[`${req.method} ${url.pathname}`] ?? routes[`${req.method} ${url.pathname}`]; // a host's own routes win
    if (!handler) return send(res, 404, { error: 'not found' });
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', async () => {
      try { send(res, 200, await handler(url.searchParams, raw ? JSON.parse(raw) : {})); } catch (e) {
        const status = e.status ?? (/not synced|syncing/.test(e.message) ? 503 : 500);
        send(res, status, { error: e.message });
      }
    });
  });

  // ─── loops ─────────────────────────────────────────────────────────────────────────────────
  const timers = [];
  const every = (ms, fn) => { const t = setInterval(() => fn().catch((e) => c.log('loop:', e.message)), ms); t.unref(); timers.push(t); };
  async function forgetDropped() {
    for (const [txid, at] of pendingSigned) {
      if (Date.now() - at < 3 * 60_000) continue;
      const s = await io.txStatus(txid);
      if (!s.found) { signer.forget(txid); pendingSigned.delete(txid); } else if (s.confirmed) pendingSigned.delete(txid);
    }
  }
  const tasks = {
    sync: () => chain.sync(),
    gates: () => topUpGates(),
    relay: async () => relay.flush(await fresh()),
    inscribe: async () => (ins ? ins.runOnce(await fresh()) : null),
    dropped: () => forgetDropped(),
  };

  await new Promise((ok) => server.listen(c.port, ok));
  await chain.sync();
  if (c.loops) {
    every(c.syncMs, tasks.sync);
    every(60_000, tasks.gates);
    every(60_000, tasks.dropped);
    if (ins) every(c.inscribeMs, tasks.inscribe);
    const scheduleRelay = () => {
      const t = setTimeout(() => tasks.relay().catch((e) => c.log('relay:', e.message)).finally(scheduleRelay), Math.floor(c.batchMs * (0.5 + Math.random())));
      t.unref();
      timers.push(t);
    };
    scheduleRelay();
  }
  c.log(`platform for "${rules.name}" on :${server.address().port} (${c.network}); wallet ${wallet.address}; gate ${gateAddress}`);
  return {
    port: server.address().port, rules, wallet, gateAddress, chain, tasks, store, io,
    close: () => { timers.forEach((t) => clearInterval(t)); return new Promise((ok) => server.close(ok)); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) startPlatform().catch((e) => { console.error(e.message); process.exit(1); });
