// The vault seed on this device, encrypted with the holder's passphrase (PBKDF2-SHA256 + AES-GCM).
// It never leaves the browser. Losing both the device copy and the backup loses the pieces.
const KEY = 'sd.vault.v1';
const ITER = 310_000;
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

const read = () => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); return true; } catch { return false; } };

async function aesKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export const hasVault = () => !!read();
export const vaultAddressHint = () => read()?.address ?? null;

export async function saveVault(seed, pass, address) {
  if (pass.length < 8) throw new Error('use a passphrase of at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(pass, salt), seed);
  if (!write({ v: 1, salt: hex(salt), iv: hex(iv), ct: hex(ct), address })) throw new Error('this browser will not store the vault (private window?): keep your backup');
}

export async function unlockVault(pass) {
  const v = read();
  if (!v) throw new Error('no vault on this device');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(v.iv) }, await aesKey(pass, unhex(v.salt)), unhex(v.ct)));
  } catch {
    throw new Error('wrong passphrase');
  }
}

export function forgetVault() { try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } }

export const seedToBackup = (seed) => hex(seed);
export function backupToSeed(text) {
  const h = String(text).trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('a backup is 64 hex characters');
  return unhex(h);
}
