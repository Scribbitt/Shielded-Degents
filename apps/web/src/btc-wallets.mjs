// Bitcoin wallets that pay for mints and buys. Each adapter returns the client's payer shape:
//   { name, address, script, coins(), signPsbt(psbt, indexes) }
// The wallet signs only its own inputs and never finalizes; the platform adds its signature after.
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { request, AddressPurpose } from 'sats-connect';
import { keyPayer } from '../../../packages/sdk/src/client.mjs';

function shapeFor(address, publicKeyHex, network) {
  const script = bitcoin.address.toOutputScript(address, network);
  const pub = publicKeyHex ? Buffer.from(publicKeyHex, 'hex') : null;
  const extra = {};
  if (script[0] === 0x51 && pub) extra.tapInternalKey = pub.length === 33 ? pub.subarray(1) : pub;
  if (script[0] === 0xa9 && pub) extra.redeemScript = bitcoin.payments.p2wpkh({ pubkey: pub, network }).output;
  return { script, extra };
}

const coinsFrom = (utxos, script, extra) => async (address) => (await utxos(address)).map((u) => ({ ...u, script, ...extra }));

// Unisat and OKX share one API shape
function unisatLike(name, provider, network, utxos) {
  return async () => {
    const p = provider();
    if (!p) throw new Error(`${name} is not installed`);
    const [address] = name === 'OKX' ? [(await p.connect()).address] : await p.requestAccounts();
    const pub = await p.getPublicKey();
    const { script, extra } = shapeFor(address, pub, network);
    const coins = coinsFrom(utxos, script, extra);
    return {
      name, address, script,
      coins: () => coins(address),
      async signPsbt(psbt, indexes) {
        const signed = await p.signPsbt(psbt.toHex(), { autoFinalized: false, toSignInputs: indexes.map((index) => ({ index, address })) });
        return bitcoin.Psbt.fromHex(signed, { network });
      },
    };
  };
}

function xverse(network, utxos) {
  return async () => {
    const r = await request('getAccounts', { purposes: [AddressPurpose.Payment], message: 'Pay for Shielded Degents mints and buys' });
    if (r.status !== 'success') throw new Error(r.error?.message ?? 'Xverse refused');
    const acct = r.result.find((a) => a.purpose === AddressPurpose.Payment) ?? r.result[0];
    const { script, extra } = shapeFor(acct.address, acct.publicKey, network);
    const coins = coinsFrom(utxos, script, extra);
    return {
      name: 'Xverse', address: acct.address, script,
      coins: () => coins(acct.address),
      async signPsbt(psbt, indexes) {
        const s = await request('signPsbt', { psbt: psbt.toBase64(), signInputs: { [acct.address]: indexes }, broadcast: false });
        if (s.status !== 'success') throw new Error(s.error?.message ?? 'Xverse did not sign');
        return bitcoin.Psbt.fromBase64(s.result.psbt, { network });
      },
    };
  };
}

// Regtest only: a throwaway key in this browser, funded by the dev stack's faucet.
function devWallet(network, utxos) {
  return async () => {
    let priv;
    try { priv = localStorage.getItem('sd.devwallet'); } catch { /* no storage */ }
    if (!priv) {
      priv = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
      try { localStorage.setItem('sd.devwallet', priv); } catch { /* session only */ }
    }
    return { name: 'Dev wallet', ...keyPayer({ priv, network, coins: utxos }) };
  };
}

/** The wallets this page can offer on `networkName`. utxos(address) -> [{ txid, vout, value }]. */
export function availableWallets(networkName, network, utxos) {
  const list = [];
  if (networkName === 'regtest' || networkName === 'signet') list.push({ id: 'dev', label: 'Dev wallet', connect: devWallet(network, utxos) });
  if (networkName !== 'regtest') {
    list.push({ id: 'unisat', label: 'Unisat', installed: () => !!globalThis.unisat, connect: unisatLike('Unisat', () => globalThis.unisat, network, utxos) });
    list.push({ id: 'okx', label: 'OKX Wallet', installed: () => !!globalThis.okxwallet?.bitcoin, connect: unisatLike('OKX', () => globalThis.okxwallet?.bitcoin, network, utxos) });
    list.push({ id: 'xverse', label: 'Xverse', installed: () => !!globalThis.XverseProviders, connect: xverse(network, utxos) });
  }
  return list;
}
