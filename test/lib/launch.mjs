// Launch a Shielded Degents collection on a regtest node: placeholder art, rules parent inscribed and
// held by the platform hot wallet, hot wallet funded. Used by the dev stack and the client e2e.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { schnorr } from '@noble/curves/secp256k1.js';
import { vkeyHash } from '../../vendor/shielded-ordinals/src/v1/rules.mjs';
import { artRoot, fileHash } from '../../vendor/shielded-ordinals/src/v1/art.mjs';
import { planInscriptions, revealTx } from '../../packages/sdk/src/inscribe.mjs';
import { xonlyOfPriv } from '../../packages/sdk/src/signers.mjs';

// ─── a tiny PNG encoder + procedural pixel Degents (placeholder art for dev only) ──────────────
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export function degentArt(i) {
  const S = 24, SCALE = 10, W = S * SCALE;
  let seed = (i + 1) * 2654435761 >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const bgs = [[24, 26, 38], [44, 20, 52], [16, 40, 48], [52, 36, 18], [20, 44, 28]];
  const skins = [[46, 252, 134], [120, 200, 80], [90, 220, 170], [180, 240, 90]];
  const ties = [[230, 60, 70], [250, 200, 60], [80, 140, 250], [240, 240, 240]];
  const bg = bgs[i % bgs.length], skin = skins[Math.floor(rnd() * skins.length)], tie = ties[Math.floor(rnd() * ties.length)];
  const px = Array.from({ length: S * S }, () => bg);
  const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < S && y < S) px[y * S + x] = c; };
  for (let y = 5; y < 15; y++) for (let x = 5; x < 19; x++) if ((x - 12) ** 2 / 49 + (y - 10) ** 2 / 25 < 1) set(x, y, skin); // head
  for (const ex of [8, 15]) { for (let y = 3; y < 7; y++) for (let x = ex - 2; x <= ex + 1; x++) set(x, y, skin); set(ex, 5, [255, 255, 255]); set(ex - 1, 5, [10, 10, 10]); }
  for (let x = 8; x < 17; x++) set(x, 12, [140, 30, 40]); // mouth
  for (let y = 15; y < S; y++) for (let x = 4; x < 20; x++) set(x, y, [16, 16, 18]); // tuxedo
  for (let y = 15; y < S; y++) for (let x = 10; x < 14; x++) set(x, y, [235, 235, 235]); // shirt
  set(11, 15, tie); set(12, 15, tie); set(10, 16, tie); set(13, 16, tie); set(11, 16, tie); set(12, 16, tie); // bow tie
  const buf = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) Buffer.from(px[Math.floor(y / SCALE) * S + Math.floor(x / SCALE)]).copy(buf, (y * W + x) * 3);
  return png(W, W, buf);
}

/**
 * keys: { gatePriv, lockPriv, walletPriv }; payouts are fresh keys unless given.
 * Returns everything the platform service needs to start.
 */
export async function launchCollection(rt, { dir, supply = 12, name = 'Shielded Degents (regtest)', keys, vkey, prices = {} }) {
  const NET = rt.NET;
  const artDir = path.join(dir, 'art');
  fs.mkdirSync(artDir, { recursive: true });
  const art = Array.from({ length: supply }, (_, i) => degentArt(i));
  art.forEach((b, i) => fs.writeFileSync(path.join(artDir, `${i}.png`), b));
  const p2tr = (priv) => bitcoin.payments.p2tr({ internalPubkey: Buffer.from(xonlyOfPriv(priv), 'hex'), network: NET });
  const hot = p2tr(keys.walletPriv);
  const randomScript = () => p2tr(Buffer.from(schnorr.utils.randomSecretKey()).toString('hex')).output;
  const rulesJson = {
    p: 'shord', v: 1, name, supply, artRoot: artRoot(art.map(fileHash)).toString('hex'), contentType: 'image/png',
    inscribeFee: 3000, relayerPayoutScript: hot.output.toString('hex'), mintPrice: prices.mintPrice ?? 50000,
    artistPayoutScript: (keys.artistScript ?? randomScript()).toString('hex'), platformPayoutScript: (keys.platformScript ?? randomScript()).toString('hex'),
    mintFee: prices.mintFee ?? 3500, saleFeeBps: 250, saleFeeMin: 1000, ticketPrice: 1500,
    gateKey: xonlyOfPriv(keys.gatePriv), lockKey: xonlyOfPriv(keys.lockPriv), spendVkeyHash: vkeyHash(vkey),
  };
  const rp = schnorr.utils.randomSecretKey();
  const plan = planInscriptions({ network: 'regtest', revealPriv: rp, items: [{ contentType: 'application/json', body: Buffer.from(JSON.stringify(rulesJson)) }] });
  const commit = await rt.fund(plan.commitScript, 20_000);
  const reveal = revealTx({ network: 'regtest', plan, revealPriv: rp, commit, outputs: [{ script: hot.output, value: 10_000 }] });
  await rt.send(reveal.hex);
  const [rulesBlock] = await rt.mine();
  const startHeight = (await rt.node('getblock', rulesBlock)).height;
  for (let i = 0; i < 5; i++) await rt.fund(hot.output, 500_000);
  await rt.mine();
  return { rulesInscriptionId: `${reveal.txid}i0`, rulesBlock, startHeight, parentOutpoint: `${reveal.txid}:0:10000`, artDir, rulesJson, art };
}
