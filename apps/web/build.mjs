// Build the web vault into apps/web/dist (or serve it): one ES module bundle, the page, the styles,
// the proving artifacts, and config.json from CONFIG (default: apps/web/config.json).
//   node apps/web/build.mjs            build
//   node apps/web/build.mjs --serve    build + serve on :8790 with live rebuilds
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DIST = path.join(HERE, 'dist');
const CONFIG = process.env.CONFIG ?? path.join(HERE, 'config.json');
const ZK_WASM = process.env.ZK_WASM ?? path.join(ROOT, 'vendor/shielded-ordinals/build/spend_js/spend.wasm');
const ZK_ZKEY = process.env.ZK_ZKEY ?? path.join(ROOT, 'zk/dev-ceremony/spend/final.zkey');

fs.mkdirSync(path.join(DIST, 'zk'), { recursive: true });
// in a container the config comes from the environment (WEB_NETWORK, PUBLIC_PLATFORM_URL, PUBLIC_ESPLORA_URL)
const envConfig = process.env.WEB_NETWORK ? JSON.stringify({
  network: process.env.WEB_NETWORK, platformUrl: process.env.PUBLIC_PLATFORM_URL, esploraUrl: process.env.PUBLIC_ESPLORA_URL || null,
  artBase: 'platform', pieceName: 'Shielded Degent', pollMs: 15000,
}, null, 2) : null;
const copy = () => {
  fs.copyFileSync(path.join(HERE, 'index.html'), path.join(DIST, 'index.html'));
  fs.copyFileSync(path.join(HERE, 'styles.css'), path.join(DIST, 'styles.css'));
  if (envConfig) fs.writeFileSync(path.join(DIST, 'config.json'), envConfig); else fs.copyFileSync(CONFIG, path.join(DIST, 'config.json'));
  fs.copyFileSync(ZK_WASM, path.join(DIST, 'zk/spend.wasm'));
  fs.copyFileSync(ZK_ZKEY, path.join(DIST, 'zk/spend.zkey'));
};

const options = {
  entryPoints: [path.join(HERE, 'src/main.mjs')],
  outfile: path.join(DIST, 'app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: !process.argv.includes('--serve'), sourcemap: true,
  // tiny-secp256k1 is WebAssembly; the pure-JS @bitcoinerlab build has the same API
  alias: { 'tiny-secp256k1': path.join(ROOT, 'node_modules/@bitcoinerlab/secp256k1') },
  inject: [path.join(HERE, 'src/shim.mjs')],
  define: { global: 'globalThis', 'process.env.NODE_DEBUG': 'false' },
  logLevel: 'info',
};

copy();
if (process.argv.includes('--serve')) {
  const http = await import('node:http');
  const fsp = await import('node:fs/promises');
  const ctx = await esbuild.context({ ...options, plugins: [{ name: 'copy', setup: (b) => b.onEnd(copy) }] });
  await ctx.watch();
  const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json', '.zkey': 'application/octet-stream' };
  const port = Number(process.env.PORT ?? 8790);
  http.default.createServer(async (req, res) => {
    let rel = new URL(req.url, 'http://x').pathname.replace(/^\//, '') || 'index.html';
    let file = path.join(DIST, rel);
    try { await fsp.access(file); } catch { file = path.join(DIST, 'index.html'); rel = 'index.html'; }
    const ext = path.extname(rel);
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(await fsp.readFile(file));
  }).listen(port, '0.0.0.0', () => console.log(`web vault on http://localhost:${port}`));
} else {
  await esbuild.build(options);
  console.log(`built ${DIST}`);
}
