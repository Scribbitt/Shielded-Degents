// Node globals some bundled libraries (bitcoinjs-lib) expect.
import { Buffer } from 'buffer';
export { Buffer };
globalThis.Buffer ??= Buffer;
globalThis.process ??= { env: {}, browser: true, version: '', nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)) };
