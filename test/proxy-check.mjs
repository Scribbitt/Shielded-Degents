// The real btc-proxy (Caddy + docker/btc-proxy.Caddyfile) in front of a fake GetBlock: plain RPC in,
// token-in-path out. Needs docker. Run: node test/proxy-check.mjs
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { makeRpc, makeSource } from '../vendor/shielded-ordinals/src/v1/follow.mjs';
import { startRegtest } from './lib/regtest.mjs';
import { fakeGetBlock } from './lib/remote-fakes.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const rt = await startRegtest(path.join(ROOT, '.regtest', 'proxy'));
const gb = await fakeGetBlock(rt, 'secret-token-xyz', '0.0.0.0');
const port = 18900 + Math.floor(Math.random() * 90);
const name = `sd-proxy-check-${port}`;
const docker = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
try {
  docker('run', '-d', '--name', name, '-p', `${port}:80`, '-e', 'GETBLOCK_SCHEME=http', '-e', `GETBLOCK_HOST=host.docker.internal:${gb.port}`,
    '-e', `GETBLOCK_TOKEN=${gb.token}`, '-v', `${path.join(ROOT, 'docker/btc-proxy.Caddyfile')}:/etc/caddy/Caddyfile:ro`, 'caddy:2-alpine');
  const rpc = makeRpc(`http://127.0.0.1:${port}`);
  let height;
  for (let i = 0; ; i++) { try { height = await rpc('getblockcount'); break; } catch (e) { if (i > 40) throw e; await new Promise((r) => setTimeout(r, 250)); } }
  assert.equal(height, await rt.node('getblockcount'));
  const src = makeSource({ rpc: `http://127.0.0.1:${port}` });
  const hash = await src.hashAt(height);
  const block = await src.block(hash);
  assert.equal(block.getId(), hash);
  const cb = block.transactions[0].getId();
  assert.deepEqual(await src.prevoutScripts(hash, cb), [null]);
  console.log(`  ✓ through Caddy: getblockcount ${height}, verified block ${hash.slice(0, 16)}…, getblock verbosity 3`);
  console.log(`  ✓ fake GetBlock saw only /${gb.token}: ${[...gb.calls.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`);
  console.log('\nPROXY CHECK PASSED');
} finally {
  try { docker('rm', '-f', name); } catch { /* gone */ }
  gb.close();
  rt.stop();
}
