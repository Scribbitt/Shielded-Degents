// Shielded Degents web vault. All keys and proofs stay in this page; the platform only ever receives
// envelopes and PSBTs. Logic lives in ShieldedClient (packages/sdk/src/client.mjs); this is the UI.
import * as bitcoin from 'bitcoinjs-lib';
import { ShieldedClient, platformUnspent } from '../../../packages/sdk/src/client.mjs';
import { vaultFromSeed, newSeed, decodeAddress } from '../../../packages/sdk/src/keys.mjs';
import { saleFee } from '../../../vendor/shielded-ordinals/src/v1/rules.mjs';
import * as store from './vault-store.mjs';
import { availableWallets } from './btc-wallets.mjs';

const NETWORKS = { mainnet: bitcoin.networks.bitcoin, signet: bitcoin.networks.testnet, testnet: bitcoin.networks.testnet, regtest: bitcoin.networks.regtest };
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};
const sats = (n) => `${Number(n).toLocaleString('en-US')} sats`;
const btc = (n) => `${(Number(n) / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')} BTC`;
const short = (s, a = 10, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

const app = { cfg: null, client: null, vault: null, payer: null, tab: 'mint', busy: false, height: null };

// ─── boot ────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  app.cfg = await (await fetch('./config.json', { cache: 'no-store' })).json();
  app.net = NETWORKS[app.cfg.network];
  app.client = new ShieldedClient({ platformUrl: app.cfg.platformUrl, network: app.net, zk: { wasm: './zk/spend.wasm', zkey: './zk/spend.zkey' } });
  const hash = location.hash.slice(1);
  if (['mint', 'vault', 'market', 'how'].includes(hash)) app.tab = hash;
  await app.client.load();
  app.height = app.client.state.lastHeight;
  render();
  setInterval(poll, app.cfg.pollMs ?? 10_000);
  // background tabs get their timers throttled: catch up as soon as the tab is looked at again
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', poll);
}

async function poll() {
  try {
    const s = await app.client.api('GET', '/status');
    if (s.lastHeight !== app.height) {
      await app.client.refresh();
      app.height = app.client.state.lastHeight;
      if (!app.busy) render();
    }
  } catch { /* keep the last view */ }
}

const utxosOf = async (address) => {
  if (app.cfg.esploraUrl) {
    const r = await fetch(`${app.cfg.esploraUrl.replace(/\/+$/, '')}/address/${address}/utxo`);
    if (!r.ok) throw new Error('could not load your wallet\'s coins');
    // only confirmed coins, or coins this page created: an unconfirmed coin from elsewhere may vanish
    return (await r.json()).map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
  }
  return (await app.client.api('GET', `/dev/utxos?address=${encodeURIComponent(address)}`)).utxos;
};

const artUrl = (assetId) => {
  const id = app.client.inscriptions?.[assetId];
  if (app.cfg.artBase && app.cfg.artBase !== 'platform' && id) return app.cfg.artBase + id;
  return `${app.cfg.platformUrl.replace(/\/+$/, '')}/art/${assetId}`;
};
const pieceName = (assetId) => `${app.cfg.pieceName ?? 'Shielded Degent'} #${assetId + 1}`;

// ─── progress + errors ───────────────────────────────────────────────────────────────────────
function toast(msg, kind = 'info', ms = 6000) {
  const t = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
async function run(label, fn) {
  if (app.busy) return;
  app.busy = true;
  const b = $('#busy');
  $('#busy-text').textContent = label;
  b.hidden = false;
  try {
    const r = await fn((m) => { $('#busy-text').textContent = m; });
    await app.client.refresh();
    app.height = app.client.state.lastHeight;
    return r;
  } catch (e) {
    toast(e.message ?? String(e), 'error', 10_000);
  } finally {
    b.hidden = true;
    app.busy = false;
    render();
  }
}

// ─── header ──────────────────────────────────────────────────────────────────────────────────
function header() {
  const net = app.cfg.network;
  return el('header', { class: 'top' },
    el('a', { class: 'brand', href: '#mint', onclick: () => go('mint') },
      el('span', { class: 'logo', 'aria-hidden': 'true' }), el('span', {}, 'Shielded Degents')),
    el('div', { class: 'top-right' },
      net !== 'mainnet' && el('span', { class: 'badge warn' }, net),
      el('span', { class: 'muted mono small', title: 'last block this page knows' }, `#${app.height ?? '…'}`),
      app.payer
        ? el('button', { class: 'chip', title: app.payer.address, onclick: () => { app.payer = null; render(); } }, `${app.payer.name} · ${short(app.payer.address, 6, 4)}`)
        : el('button', { class: 'btn small', onclick: connectDialog }, 'Connect wallet'),
      app.vault
        ? el('button', { class: 'chip green', title: app.vault.address, onclick: () => go('vault') }, `Vault · ${short(app.vault.address, 8, 4)}`)
        : el('button', { class: 'btn small ghost', onclick: () => go('vault') }, store.hasVault() ? 'Unlock vault' : 'Create vault')));
}

function nav() {
  const tabs = [['mint', 'Mint'], ['vault', 'My vault'], ['market', 'Market'], ['how', 'How it works']];
  return el('nav', { class: 'tabs', 'aria-label': 'Sections' },
    tabs.map(([id, label]) => el('a', { href: `#${id}`, class: app.tab === id ? 'active' : '', 'aria-current': app.tab === id ? 'page' : false, onclick: (e) => { e.preventDefault(); go(id); } }, label)));
}
function go(tab) { app.tab = tab; history.replaceState(null, '', `#${tab}`); render(); }

// ─── mint ────────────────────────────────────────────────────────────────────────────────────
function mintView() {
  const c = app.client, R = c.rules;
  const left = c.unminted().length;
  const minted = R.supply - left;
  const qty = Math.min(app.mintQty ?? 1, Math.max(1, Math.min(20, left)));
  const tickets = app.mintTickets ?? 2;
  const each = R.mintPrice + R.mintFee + R.inscribeFee + tickets * R.ticketPrice;
  const set = (k, v) => { app[k] = v; render(); };
  return el('section', { class: 'panel' },
    el('div', { class: 'hero' },
      el('div', {},
        el('h1', {}, R.name),
        el('p', { class: 'lead' }, 'Public art on Bitcoin. Private owners. Every piece is inscribed as a child of the collection; who holds it lives in your shielded vault, and nobody can see it.'),
        el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': R.supply, 'aria-valuenow': minted },
          el('div', { class: 'bar', style: `width:${(100 * minted) / R.supply}%` })),
        el('p', { class: 'muted small' }, `${minted.toLocaleString()} / ${R.supply.toLocaleString()} minted`)),
      el('div', { class: 'card mint-card' },
        left === 0 ? el('p', {}, 'Minted out. Find pieces in the market.') : [
          el('label', { class: 'field' }, el('span', {}, 'Pieces'),
            el('div', { class: 'stepper' },
              el('button', { class: 'btn ghost', 'aria-label': 'fewer', onclick: () => set('mintQty', Math.max(1, qty - 1)) }, '−'),
              el('output', { class: 'mono' }, qty),
              el('button', { class: 'btn ghost', 'aria-label': 'more', onclick: () => set('mintQty', Math.min(20, left, qty + 1)) }, '+'))),
          el('label', { class: 'field' }, el('span', {}, 'Relay tickets per piece'),
            el('select', { onchange: (e) => set('mintTickets', Number(e.target.value)) },
              [0, 1, 2, 3, 5, 10].map((n) => el('option', { value: n, selected: n === tickets }, String(n))))),
          el('p', { class: 'hint' }, 'A ticket lets you send or list a piece without paying from a visible wallet: the relayer publishes it for you, batched with others.'),
          el('dl', { class: 'costs' },
            el('dt', {}, 'Mint price'), el('dd', {}, sats(R.mintPrice * qty)),
            R.mintFee > 0 && [el('dt', {}, 'Platform fee'), el('dd', {}, sats(R.mintFee * qty))],
            el('dt', {}, 'Inscription'), el('dd', {}, sats(R.inscribeFee * qty)),
            tickets > 0 && [el('dt', {}, `Tickets (${tickets * qty})`), el('dd', {}, sats(tickets * qty * R.ticketPrice))],
            el('dt', { class: 'total' }, 'Total'), el('dd', { class: 'total' }, `${sats(each * qty)} + network fee`)),
          el('button', { class: 'btn primary wide', onclick: () => doMint(qty, tickets) }, `Mint ${qty}`),
        ])));
}

async function doMint(count, ticketsPerPiece) {
  if (!app.vault) { go('vault'); return toast('Create or unlock your vault first: the pieces go there.'); }
  if (!app.payer) return connectDialog();
  const r = await run('Reserving a mint slot…', async (say) => {
    say('Building the mint. Confirm in your wallet…');
    return app.client.mint({ vault: app.vault, payer: app.payer, count, ticketsPerPiece });
  });
  if (r) toast(`Minted ${r.assetIds.map(pieceName).join(', ')}. It shows in your vault after the next block.`, 'ok', 12_000);
}

// ─── vault ───────────────────────────────────────────────────────────────────────────────────
function vaultGate() {
  if (store.hasVault()) {
    const pass = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Passphrase', 'aria-label': 'Passphrase' });
    const unlock = () => run('Unlocking…', async () => openVault(await store.unlockVault(pass.value)));
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
    return el('section', { class: 'panel narrow' },
      el('h2', {}, 'Unlock your vault'),
      el('p', { class: 'muted' }, `Vault ${short(store.vaultAddressHint() ?? '', 10, 6)} is on this device.`),
      pass, el('button', { class: 'btn primary wide', onclick: unlock }, 'Unlock'),
      el('details', { class: 'small' }, el('summary', {}, 'Use another vault'),
        el('p', { class: 'muted' }, 'Removing this vault from the device only deletes the local copy. Without its backup, its pieces are gone for good.'),
        el('button', { class: 'btn danger', onclick: () => { if (confirm('Remove this vault from this device? Make sure you have its backup.')) { store.forgetVault(); render(); } } }, 'Remove from this device')));
  }
  const p1 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'New passphrase (8+ characters)', 'aria-label': 'New passphrase' });
  const p2 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Repeat passphrase', 'aria-label': 'Repeat passphrase' });
  const backup = el('textarea', { rows: 2, placeholder: 'Backup (64 hex characters)', 'aria-label': 'Vault backup', spellcheck: 'false' });
  const check = () => { if (p1.value !== p2.value) throw new Error('the passphrases differ'); return p1.value; };
  return el('section', { class: 'panel narrow' },
    el('h2', {}, 'Your shielded vault'),
    el('p', { class: 'muted' }, 'The vault holds your pieces. Its key is made on this device and never leaves it, so nobody (not even the platform) can see what you own.'),
    p1, p2,
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: () => run('Creating your vault…', async () => { const pass = check(); const seed = newSeed(); await showBackup(seed); await store.saveVault(seed, pass, vaultFromSeed(seed).address); openVault(seed); }) }, 'Create a new vault')),
    el('details', {}, el('summary', {}, 'Restore from a backup'), backup,
      el('button', { class: 'btn', onclick: () => run('Restoring…', async () => { const pass = check(); const seed = store.backupToSeed(backup.value); await store.saveVault(seed, pass, vaultFromSeed(seed).address); openVault(seed); }) }, 'Restore')));
}

function showBackup(seed) {
  return new Promise((resolve) => {
    const code = store.seedToBackup(seed);
    const ok = el('input', { type: 'checkbox', id: 'saved' });
    const done = el('button', { class: 'btn primary', disabled: true, onclick: () => { d.close(); d.remove(); resolve(); } }, 'Continue');
    ok.addEventListener('change', () => { done.disabled = !ok.checked; });
    const d = el('dialog', { class: 'dialog' },
      el('h3', {}, 'Save your vault backup'),
      el('p', {}, 'This is the only way to recover your pieces if this browser is lost. Write it down or keep it in a password manager. Anyone with it controls your pieces.'),
      el('pre', { class: 'backup mono' }, code.match(/.{1,16}/g).join(' ')),
      el('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(code).then(() => toast('Copied')) }, 'Copy'),
      el('label', { class: 'check', for: 'saved' }, ok, ' I saved my backup somewhere safe'),
      el('div', { class: 'row end' }, done));
    d.addEventListener('cancel', (e) => e.preventDefault());
    document.body.append(d);
    d.showModal();
  });
}

function openVault(seed) { app.vault = vaultFromSeed(seed); }

function vaultView() {
  if (!app.vault) return vaultGate();
  const v = app.client.view(app.vault);
  const active = v.listings.filter((l) => l.state === 'ACTIVE');
  const sold = v.proceeds;
  return el('section', { class: 'panel' },
    el('div', { class: 'vault-head' },
      el('div', {},
        el('h2', {}, 'My vault'),
        el('p', { class: 'muted small' }, 'Your shielded address. Share it to receive pieces privately.'),
        el('div', { class: 'addr mono' }, app.vault.address,
          el('button', { class: 'btn small ghost', onclick: () => navigator.clipboard?.writeText(app.vault.address).then(() => toast('Address copied')) }, 'Copy'))),
      el('button', { class: 'btn ghost small', onclick: () => { app.vault = null; render(); } }, 'Lock')),
    sold.length > 0 && el('div', { class: 'card proceeds' },
      el('div', {}, el('strong', {}, `${sold.length} sale${sold.length > 1 ? 's' : ''}`), el('span', { class: 'muted' }, ` · ${sats(sold.reduce((s, p) => s + Number(p.listing.price), 0))} on your payout keys`)),
      el('button', { class: 'btn primary', onclick: withdraw }, 'Withdraw to wallet')),
    el('h3', {}, `Pieces (${v.unspent.length})`),
    v.unspent.length === 0
      ? el('p', { class: 'empty muted' }, 'No pieces yet. Mint one, buy one, or share your address to receive one.')
      : el('div', { class: 'grid' }, v.unspent.map(pieceCard)),
    active.length > 0 && [el('h3', {}, `Listed (${active.length})`), el('div', { class: 'grid' }, active.map(myListingCard))]);
}

function pieceCard(note) {
  return el('article', { class: 'piece' },
    el('img', { src: artUrl(note.assetId), alt: pieceName(note.assetId), loading: 'lazy', width: 240, height: 240 }),
    el('div', { class: 'piece-body' },
      el('h4', {}, pieceName(note.assetId)),
      el('p', { class: 'muted small' }, `${note.tickets} relay ticket${note.tickets === 1 ? '' : 's'}`),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', onclick: () => sendDialog(note) }, 'Send'),
        el('button', { class: 'btn small', onclick: () => listDialog(note) }, 'List'))));
}

function myListingCard(l) {
  return el('article', { class: 'piece' },
    el('img', { src: artUrl(l.assetId), alt: pieceName(l.assetId), loading: 'lazy', width: 240, height: 240 }),
    el('div', { class: 'piece-body' },
      el('h4', {}, pieceName(l.assetId)),
      el('p', { class: 'mono' }, btc(l.price)),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', onclick: () => run('Cancelling…', () => app.client.cancel({ vault: app.vault, listing: l })).then((r) => r && toast('Cancel sent. The piece returns to your vault after the next block.', 'ok')) }, 'Cancel'),
        l.canEscape && el('button', { class: 'btn small ghost', title: 'Takes the piece back without the platform (after 1008 blocks)', onclick: () => needPayer() && run('Reclaiming…', () => app.client.escape({ vault: app.vault, payer: app.payer, listing: l })) }, 'Reclaim alone'))));
}

function needPayer() { if (!app.payer) { connectDialog(); return false; } return true; }

function dialog(title, body, actionLabel, action) {
  const d = el('dialog', { class: 'dialog' },
    el('h3', {}, title), body,
    el('div', { class: 'row end' },
      el('button', { class: 'btn ghost', onclick: () => { d.close(); d.remove(); } }, 'Close'),
      el('button', { class: 'btn primary', onclick: async () => { d.close(); d.remove(); await action(); } }, actionLabel)));
  document.body.append(d);
  d.showModal();
}

function sendDialog(note) {
  const to = el('input', { placeholder: 'shord1…', 'aria-label': 'Recipient shielded address', spellcheck: 'false' });
  dialog(`Send ${pieceName(note.assetId)}`,
    el('div', {}, el('p', { class: 'muted' }, note.tickets > 0
      ? 'Sent privately through the relayer with one of the piece\'s tickets. Nothing on chain links you and the recipient.'
      : 'This piece has no ticket left, so your wallet pays the network fee and that wallet is visible on the transaction.'), to),
    'Send', () => {
      try { decodeAddress(to.value.trim()); } catch (e) { return toast(e.message, 'error'); }
      if (note.tickets === 0 && !needPayer()) return;
      return run('Making the proof (a few seconds)…', () => app.client.send({ vault: app.vault, note, to: to.value.trim(), payer: app.payer }))
        .then((r) => r && toast('Sent. It leaves your vault once it is in a block.', 'ok'));
    });
}

function listDialog(note) {
  const price = el('input', { type: 'number', min: '0.00001', step: '0.00001', placeholder: 'Price in BTC', 'aria-label': 'Price in BTC' });
  const out = el('p', { class: 'muted small' }, ' ');
  price.addEventListener('input', () => {
    const p = Math.round(Number(price.value) * 1e8);
    out.textContent = p > 0 ? `You receive ${sats(p)}. The buyer also pays the platform fee of ${sats(saleFee(app.client.rules, BigInt(p)))}. No royalties.` : ' ';
  });
  dialog(`List ${pieceName(note.assetId)}`,
    el('div', {}, el('p', { class: 'muted' }, 'A listing is public: the piece and price show in the market until it sells or you cancel. The price is paid to a fresh key only your vault holds.'), price, out),
    'List', () => {
      const p = Math.round(Number(price.value) * 1e8);
      if (!(p >= 1000)) return toast('Set a price of at least 1,000 sats', 'error');
      if (note.tickets === 0 && !needPayer()) return;
      return run('Making the proof (a few seconds)…', () => app.client.list({ vault: app.vault, note, price: p, payer: app.payer }))
        .then((r) => r && toast('Listed. It shows in the market after the next batch is in a block.', 'ok'));
    });
}

async function withdraw() {
  if (!needPayer()) return;
  const r = await run('Collecting your sale proceeds…', () => app.client.withdraw({ vault: app.vault, toScript: app.payer.script, isUnspent: platformUnspent(app.client) }));
  if (r) toast(`Withdrew ${sats(r.amount)} (minus the network fee) to ${app.payer.name}.`, 'ok');
}

// ─── market ──────────────────────────────────────────────────────────────────────────────────
function marketView() {
  const list = app.client.market(app.vault).sort((a, b) => Number(BigInt(a.price) - BigInt(b.price)));
  return el('section', { class: 'panel' },
    el('h2', {}, 'Market'),
    el('p', { class: 'muted' }, 'Listed pieces. Buying puts the piece straight into your shielded vault.'),
    list.length === 0 ? el('p', { class: 'empty muted' }, 'Nothing listed right now.') :
      el('div', { class: 'grid' }, list.map((l) => {
        const fee = saleFee(app.client.rules, BigInt(l.price));
        return el('article', { class: 'piece' },
          el('img', { src: artUrl(l.assetId), alt: pieceName(l.assetId), loading: 'lazy', width: 240, height: 240 }),
          el('div', { class: 'piece-body' },
            el('h4', {}, pieceName(l.assetId)),
            el('p', { class: 'mono' }, btc(l.price)),
            el('p', { class: 'muted small' }, `+ ${sats(fee)} fee · ${l.tickets} ticket${l.tickets === 1 ? '' : 's'}`),
            el('button', { class: 'btn primary small', onclick: () => buy(l) }, 'Buy')));
      })));
}

async function buy(listing) {
  if (!app.vault) { go('vault'); return toast('Create or unlock your vault first: the piece goes there.'); }
  if (!needPayer()) return;
  const r = await run('Building the purchase. Confirm in your wallet…', () => app.client.buy({ vault: app.vault, payer: app.payer, listing }));
  if (r) toast(`Bought ${pieceName(listing.assetId)}. It shows in your vault after the next block.`, 'ok', 12_000);
}

// ─── about ───────────────────────────────────────────────────────────────────────────────────
function howView() {
  const R = app.client.rules;
  return el('section', { class: 'panel prose' },
    el('h2', {}, 'How it works'),
    el('p', {}, 'Every piece\'s art is a public inscription on Bitcoin, a child of the collection\'s parent inscription. Ownership is not tied to a Bitcoin address. It lives as a hidden note in a Merkle tree, and only your vault can open your notes.'),
    el('h3', {}, 'What happens on chain'),
    el('ul', {},
      el('li', {}, 'Mint, send, list, buy and cancel are ordinary Bitcoin transactions, each carrying one small data message (OP_RETURN).'),
      el('li', {}, 'A send or a listing carries a zero-knowledge proof that the sender holds a piece, without saying which note is theirs.'),
      el('li', {}, 'Anyone can rebuild who-owns-what-in-secret from Bitcoin blocks with the open indexer and get the same state.')),
    el('h3', {}, 'What the platform can and cannot do'),
    el('ul', {},
      el('li', {}, 'It co-signs mints and purchases so a piece is never minted or sold twice.'),
      el('li', {}, 'It cannot move your pieces, see which ones are yours, or change a sale. Your keys never leave this page.'),
      el('li', {}, 'If it stopped, you could still send, and take back an unsold listing alone after 1008 blocks.')),
    el('h3', {}, 'This collection'),
    el('dl', { class: 'costs' },
      el('dt', {}, 'Parent inscription'), el('dd', { class: 'mono small' }, short(app.client.parentId, 12, 6)),
      el('dt', {}, 'Supply'), el('dd', {}, R.supply.toLocaleString()),
      el('dt', {}, 'Sale fee'), el('dd', {}, `${R.saleFeeBps / 100}% (min ${sats(R.saleFeeMin)}), no royalties`),
      el('dt', {}, 'Relay ticket'), el('dd', {}, sats(R.ticketPrice))));
}

// ─── wallet connect ──────────────────────────────────────────────────────────────────────────
function connectDialog() {
  const wallets = availableWallets(app.cfg.network, app.net, utxosOf);
  const d = el('dialog', { class: 'dialog' },
    el('h3', {}, 'Connect a Bitcoin wallet'),
    el('p', { class: 'muted' }, 'It pays for mints and purchases. Your pieces go to your shielded vault, not to this wallet.'),
    el('div', { class: 'wallets' }, wallets.map((w) => el('button', {
      class: 'btn wide', disabled: w.installed && !w.installed(),
      onclick: async () => {
        d.close(); d.remove();
        await run(`Connecting ${w.label}…`, async () => {
          app.payer = await w.connect();
          if (app.cfg.network === 'regtest' && w.id === 'dev') await devTopUp();
        });
      },
    }, w.label, w.installed && !w.installed() ? el('span', { class: 'muted small' }, ' (not installed)') : null))),
    el('div', { class: 'row end' }, el('button', { class: 'btn ghost', onclick: () => { d.close(); d.remove(); } }, 'Close')));
  document.body.append(d);
  d.showModal();
}

async function devTopUp() {
  const coins = await app.payer.coins();
  if (coins.reduce((s, c) => s + c.value, 0) < 1_000_000) await app.client.api('POST', '/dev/faucet', { address: app.payer.address, sats: 5_000_000 });
}

// ─── render ──────────────────────────────────────────────────────────────────────────────────
function render() {
  const views = { mint: mintView, vault: vaultView, market: marketView, how: howView };
  $('#app').replaceChildren(header(), nav(), el('main', { id: 'main' }, views[app.tab]()),
    el('footer', { class: 'muted small' }, 'Shielded Degents · keys and proofs stay in this browser · ', el('a', { href: '#how', onclick: () => go('how') }, 'how it works')));
}

window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== app.tab && ['mint', 'vault', 'market', 'how'].includes(h)) { app.tab = h; render(); } });
boot().catch((e) => { $('#app').replaceChildren(el('div', { class: 'panel narrow' }, el('h2', {}, 'Could not reach the platform'), el('p', { class: 'muted' }, e.message))); });
globalThis.__sd = app; // handy in the console during development
