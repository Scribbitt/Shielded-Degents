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
const copy = () => {
  fs.copyFileSync(path.join(HERE, 'index.html'), path.join(DIST, 'index.html'));
  fs.copyFileSync(path.join(HERE, 'styles.css'), path.join(DIST, 'styles.css'));
  fs.copyFileSync(CONFIG, path.join(DIST, 'config.json'));
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
  const ctx = await esbuild.context({ ...options, plugins: [{ name: 'copy', setup: (b) => b.onEnd(copy) }] });
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: DIST, port: Number(process.env.PORT ?? 8790) });
  console.log(`web vault on http://localhost:${port}`);
} else {
  await esbuild.build(options);
  console.log(`built ${DIST}`);
}
