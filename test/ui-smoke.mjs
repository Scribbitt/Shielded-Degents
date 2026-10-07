// Headless browser run of the web vault against the dev stack (npm run dev must be running).
// Two separate browser profiles: Alice creates a vault, mints, lists; Bob creates a vault and buys.
//   node test/ui-smoke.mjs [--shots <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const URL_ = process.env.WEB_URL ?? 'http://localhost:8790';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'sd-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const ok = (m) => console.log(`  ✓ ${m}`);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check'] });
const errors = [];
async function newUser(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  await page.goto(URL_, { waitUntil: 'networkidle0' });
  return page;
}
// only buttons and links: a text selector alone also matches paragraphs that mention the word
const click = (page, text) => page.locator(`button::-p-text(${text}), a::-p-text(${text})`).click();
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
const idle = (page) => page.waitForSelector('#busy[hidden]', { timeout: 120_000 });
async function waitFor(page, fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function createVault(page) {
  await click(page, 'Create vault');
  await page.type('input[placeholder^="New passphrase"]', 'correct horse battery');
  await page.type('input[placeholder="Repeat passphrase"]', 'correct horse battery');
  await click(page, 'Create a new vault');
  await page.waitForSelector('dialog[open] .backup');
  await page.click('dialog[open] #saved');
  await click(page, 'Continue');
  await idle(page);
  await page.waitForSelector('.addr');
}
async function connectDev(page) {
  await click(page, 'Connect wallet');
  await click(page, 'Dev wallet (regtest)');
  await idle(page);
  await page.waitForSelector('::-p-text(Dev wallet ·)');
}

try {
  console.log(`▸ ${URL_} (screenshots in ${SHOTS})`);
  const alice = await newUser('alice');
  await page_title(alice);
  await shot(alice, '01-mint-landing');
  ok('landing renders');

  await createVault(alice);
  await shot(alice, '02-vault-created');
  ok('Alice created a vault (backup shown, encrypted on the device)');

  await connectDev(alice);
  ok('dev wallet connected and funded');

  await click(alice, 'Mint');
  await alice.locator('::-p-aria(more)').click();
  await shot(alice, '03-mint-two');
  await click(alice, 'Mint 2');
  await idle(alice);
  await click(alice, 'My vault');
  await waitFor(alice, () => document.querySelectorAll('.piece').length === 2, 'two pieces in Alice\'s vault');
  await waitFor(alice, () => [...document.querySelectorAll('.piece img')].every((i) => i.complete && i.naturalWidth > 0), 'art to load');
  await shot(alice, '04-vault-two-pieces');
  ok('mint of 2 landed; both pieces and their art show in the vault');

  await alice.locator('.piece button::-p-text(List)').click();
  await alice.type('dialog[open] input[type=number]', '0.0005');
  await alice.click('dialog[open] button.primary');
  await idle(alice);
  await waitFor(alice, () => document.body.textContent.includes('Listed (1)'), 'the listing to confirm');
  const listedName = await alice.evaluate(() => [...document.querySelectorAll('h3')].find((h) => h.textContent.startsWith('Listed')).nextElementSibling.querySelector('h4').textContent);
  await shot(alice, '05-listed');
  ok('Alice listed a piece (relayed, with proof made in the browser)');

  const bob = await newUser('bob');
  await createVault(bob);
  await connectDev(bob);
  await click(bob, 'Market');
  await bob.waitForSelector('.piece');
  await shot(bob, '06-market');
  // the dev chain persists between runs: buy exactly the piece this Alice listed
  await bob.waitForFunction((n) => [...document.querySelectorAll('.piece h4')].some((h) => h.textContent === n), {}, listedName);
  await bob.evaluate((n) => [...document.querySelectorAll('.piece')].find((p) => p.querySelector('h4').textContent === n).querySelector('button').click(), listedName);
  await idle(bob);
  await click(bob, 'My vault');
  await waitFor(bob, () => document.querySelectorAll('.piece').length === 1, 'the bought piece in Bob\'s vault');
  await shot(bob, '07-bob-vault');
  ok('Bob bought it from the market; it is in his vault');

  await alice.bringToFront();
  await click(alice, 'My vault');
  await waitFor(alice, () => document.body.textContent.includes('Withdraw to wallet'), 'Alice\'s proceeds', 30_000);
  await click(alice, 'Withdraw to wallet');
  await idle(alice);
  await shot(alice, '08-alice-withdrawn');
  ok('Alice withdrew the sale proceeds to her wallet');

  const ignorable = (e) => /favicon|ERR_BLOCKED_BY_CLIENT|status of 404/.test(e);
  const real = errors.filter((e) => !ignorable(e));
  assert.deepEqual(real, [], 'page errors:\n' + real.join('\n'));
  ok('no page errors');
  console.log('\nUI SMOKE PASSED');
} catch (e) {
  for (const p of (await browser.pages())) {
    const dbg = await p.evaluate(() => {
      const a = globalThis.__sd;
      if (!a?.vault) return null;
      const v = a.client.view(a.vault);
      return { height: a.height, stateHeight: a.client.state.lastHeight, busy: a.busy, listings: v.listings.map((l) => [l.assetId, l.state, l.sellerScript.slice(0, 12)]), proceeds: v.proceeds.length };
    }).catch((e) => e.message);
    if (dbg) console.error('page state:', JSON.stringify(dbg));
  }
  for (const p of (await browser.pages())) await p.screenshot({ path: path.join(SHOTS, `fail-${Math.random().toString(36).slice(2, 6)}.png`), fullPage: true }).catch(() => {});
  if (errors.length) console.error('page errors:\n' + errors.join('\n'));
  throw e;
} finally {
  await browser.close();
}

async function page_title(page) {
  await page.waitForSelector('h1');
  assert.match(await page.$eval('h1', (h) => h.textContent), /Shielded Degents/);
}
