// What the platform's hot wallet needs from Bitcoin: its coins, fee rates, broadcast, tx lookup.
// Two backends, same shape:
//   rpc      your Bitcoin Core node. The platform's addresses are imported into a watch-only
//            descriptor wallet once, so listunspent works with no txindex and no third party.
//   esplora  any esplora / mempool.space-compatible API.
import { makeRpc, makeApi } from '../../../vendor/shielded-ordinals/src/v1/follow.mjs';

export function chainIO({ rpc, rpcCookie, api, walletName = 'shielded-degents-platform' }) {
  if (rpc) {
    const node = makeRpc(rpc, rpcCookie);
    const base = rpc.replace(/\/+$/, '');
    const wallet = makeRpc(`${base}/wallet/${walletName}`, rpcCookie);
    return {
      kind: 'rpc',
      async watch(addresses) {
        const have = await node('listwallets');
        if (!have.includes(walletName)) {
          try { await node('loadwallet', walletName); } catch { await node('createwallet', walletName, true, true, '', false, true); }
        }
        const descs = await Promise.all(addresses.map(async (a) => (await node('getdescriptorinfo', `addr(${a})`)).descriptor));
        await wallet('importdescriptors', descs.map((desc) => ({ desc, timestamp: 'now', label: 'platform' })));
      },
      async utxos(address) {
        const list = await wallet('listunspent', 0, 9999999, [address]);
        return list.map((u) => ({ txid: u.txid, vout: u.vout, value: Math.round(u.amount * 1e8), confirmed: u.confirmations > 0 }));
      },
      async feeRate(blocks = 2) {
        const r = await node('estimatesmartfee', blocks);
        return r.feerate ? Math.max(1, Math.ceil((r.feerate * 1e8) / 1000)) : 2;
      },
      broadcast: (hex) => node('sendrawtransaction', hex, 0),
      async txStatus(txid) {
        try {
          const t = await wallet('gettransaction', txid);
          return { found: true, confirmed: t.confirmations > 0 };
        } catch {
          try { await node('getmempoolentry', txid); return { found: true, confirmed: false }; } catch { return { found: false }; }
        }
      },
      rawTx: (txid) => node('getrawtransaction', txid, false),
      isUnspent: async (txid, vout) => (await node('gettxout', txid, vout, true)) !== null,
    };
  }
  const get = makeApi(String(api).replace(/\/+$/, ''));
  return {
    kind: 'esplora',
    async watch() {},
    async utxos(address) {
      return (await get(`/address/${address}/utxo`)).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, confirmed: u.status.confirmed }));
    },
    async feeRate() {
      const f = await get('/v1/fees/recommended');
      return Math.max(1, Number(f.halfHourFee));
    },
    async broadcast(hex) {
      const r = await fetch(String(api).replace(/\/+$/, '') + '/tx', { method: 'POST', body: hex });
      const t = await r.text();
      if (!r.ok) throw new Error('broadcast rejected: ' + t.slice(0, 200));
      return t.trim();
    },
    async txStatus(txid) {
      try { const s = await get(`/tx/${txid}/status`); return { found: true, confirmed: s.confirmed }; } catch (e) { if (e.status === 404) return { found: false }; throw e; }
    },
    rawTx: async (txid) => String(await get(`/tx/${txid}/hex`, 'text')).trim(),
    isUnspent: async (txid, vout) => !(await get(`/tx/${txid}/outspend/${vout}`)).spent,
  };
}
