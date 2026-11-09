// LIVE TESTNET browser run of the real pages (pnpm serve + headless Chrome), with a signed-in Wallet Selector 10 /
// MyNearWallet session reproduced exactly as MyNearWallet leaves it after sign-in: `signedAccountId` + `functionCallKey`
// (a function-call key scoped to the event, added on-chain here with near keychain keys, as the wallet does at sign-in).
// Covers: widget signed-in state + door pass button, gasless Cancel through the relayer, RSVP handing the exact tx to the
// wallet, relayer-down fallback to the wallet, door page gasless check_in by the host, dashboard Export CSV after settle.
// Moves testnet NEAR only; never prints keys. Needs `pnpm serve` (BASE, default http://localhost:8080) and playwright-core.
// Env: CANCEL_S (240), CHECKIN_S (120). Log: docs/testnet-browser-e2e-<date>.log
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs'; import path from 'node:path';
import * as N from '../lib/nep366.mjs';
import * as near from '../relayer/near.mjs';
import { createRelay, liveChain, serve, explorerTx } from '../relayer/server.mjs';
import { TGAS } from '../relayer/policy.mjs';
import { ed25519, b58encode } from '../widget/vendor/crypto.js';
import { formatNear } from '../widget/core.mjs';

let chromium;
try { ({ chromium } = await import('playwright-core')); } catch { try { ({ chromium } = createRequire(import.meta.url)('playwright-core')); } catch {} }
if (!chromium) { console.error('playwright-core not found: npm i --no-save playwright-core (or set NODE_PATH)'); process.exit(2); }

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.env.BASE || 'http://localhost:8080', CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const FACTORY = 'showup-factory-1793597558.testnet', HOST = 'showup-rhost-1793775606.testnet', RELAYER = 'showup-relayer-1793775606.testnet';
const GA = 'showup-rguest-a-1793775606.testnet', GB = 'showup-rguest-b-1793775606.testnet', GC = 'showup-guest-1793597596.testnet';
const CANCEL_S = Number(process.env.CANCEL_S || 240), CHECKIN_S = Number(process.env.CHECKIN_S || 120);
const T = Math.floor(Date.now() / 1000), DEPOSIT = 10n ** 22n, MILLI = 10n ** 21n;
const NAME = `ui-${T}`, EV = `${NAME}.${FACTORY}`, PORT = Number(process.env.RELAYER_PORT || 0); // 0 = any free port
let RELAY_URL;
const logFile = path.join(ROOT, 'docs', `testnet-browser-e2e-${new Date().toISOString().slice(0, 10)}.log`);
const lines = []; let pass = 0, fail = 0;
const log = (s) => { console.log(s); lines.push(s); fs.writeFileSync(logFile, lines.join('\n') + '\n'); };
const check = (sc, ok, detail, hash) => { ok ? pass++ : fail++; log(`${ok ? 'PASS' : 'FAIL'} ${sc}: ${detail}${hash ? ' ' + explorerTx(hash) : ''}`); return ok; };
async function step(sc, fn) { try { await fn(); } catch (e) { check(sc, false, `exception: ${String(e.message || e).replace(/\s+/g, ' ').slice(0, 300)}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (a) => BigInt((await near.viewAccount(a)).amount);
const status = (a) => near.view(EV, 'get_status', { account_id: a });
const fc = (m, args = {}, deposit = 0n, gas = 30n * TGAS) => [N.actions.functionCall(m, args, gas, deposit)];
const near4 = (y) => `${y < 0n ? '-' : ''}${formatNear(y < 0n ? -y : y, 24)} NEAR`;
async function until(fn, timeoutMs = 60_000, everyMs = 2000) { const end = Date.now() + timeoutMs; let v; for (;;) { v = await fn().catch(() => undefined); if (v || Date.now() > end) return v; await sleep(everyMs); } }
async function stableBal(a) { let b = await bal(a); for (let i = 0; i < 10; i++) { await sleep(3000); const c = await bal(a); if (c === b) return b; b = c; } return b; }
async function waitUntilNs(ns, what) {
  log(`# waiting for ${what} (${new Date(Number(ns / 1_000_000n)).toISOString()})…`);
  for (;;) { const bt = BigInt((await near.finalBlock()).header.timestamp_nanosec); if (bt >= ns && BigInt(Date.now()) * 1_000_000n >= ns + 2_000_000_000n) return; await sleep(5000); }
}
async function ok(sc, signer, receiver, acts, detail) { const r = await near.sendTx(signer, receiver, acts); check(sc, !r.failures.length, r.failures.length ? `tx FAILED ${JSON.stringify(r.failures[0]).slice(0, 200)}` : detail, r.hash); return r; }
/** Adds an event-scoped function-call key (what MyNearWallet does at sign-in) and returns its secret (never logged). */
async function signInKey(k) {
  const seed = new Uint8Array(randomBytes(32)), pub = ed25519.getPublicKey(seed), publicKey = 'ed25519:' + b58encode(pub);
  const sk = 'ed25519:' + b58encode(new Uint8Array([...seed, ...pub]));
  await ok(`0 sign-in key for ${k.accountId.split('.')[0]}`, k, k.accountId, [{ type: 'AddKey', publicKey, accessKey: { nonce: 0n, permission: { allowance: 25n * 10n ** 22n, receiverId: EV, methodNames: [] } } }], `function-call key scoped to the event, 0.25 NEAR allowance`);
  await until(async () => (await near.accessKey(k.accountId, publicKey)) != null, 30_000);
  return sk;
}
const session = (accountId, privateKey) => ({ 'near-wallet-selector:selectedWalletId': JSON.stringify('my-near-wallet'),
  'near-wallet-selector:recentlySignedInWallets': JSON.stringify(['my-near-wallet']), 'near-wallet-selector:contract': JSON.stringify({ contractId: EV, methodNames: [] }),
  signedAccountId: accountId, functionCallKey: JSON.stringify({ privateKey, contractId: EV, methods: [] }) });
async function context(browser, store) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true });
  await ctx.addInitScript((s) => { if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') if (!sessionStorage.getItem('seeded')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, store);
  const errs = []; ctx.on('page', (p) => p.on('pageerror', (e) => errs.push(e.message)));
  return { ctx, errs };
}
const widgetText = (page) => page.evaluate(() => document.querySelector('#live')?.shadowRoot?.querySelector('.card')?.innerText || '');
const widgetBtn = (page) => page.locator('#live').locator('button.rsvp').first();
async function walletTx(ctx, page, click) {
  const popup = ctx.waitForEvent('page', { timeout: 25_000 }).catch(() => null), nav = page.waitForURL(/mynearwallet/, { timeout: 25_000 }).then(() => page.url()).catch(() => null);
  await click();
  const p = await Promise.race([popup, nav.then(() => null)]);
  const url = p ? (await p.waitForURL(/mynearwallet/, { timeout: 20_000 }).catch(() => {}), p.url()) : page.url();
  if (p) await p.close().catch(() => {});
  return url && /mynearwallet/.test(url) ? new URL(url) : null;
}

for (const a of [FACTORY, HOST, RELAYER, GA, GB, GC]) near.assertTestnet(a);
const [host, gA, gB, gC, relayer] = [HOST, GA, GB, GC, RELAYER].map((a) => near.loadKey(a));
log(`# ShowUp browser E2E, NEAR TESTNET, ${new Date().toISOString()}; pages ${BASE}; event ${EV}; relayer ${RELAYER}; CANCEL_S=${CANCEL_S} CHECKIN_S=${CHECKIN_S}`);
let browser, server, cancelNs, endNs;
try {
  await step('1 create event + RSVPs', async () => {
    const now = BigInt(Date.now()) * 1_000_000n; cancelNs = now + BigInt(CANCEL_S) * 1_000_000_000n; endNs = cancelNs + BigInt(CHECKIN_S) * 1_000_000_000n;
    const min = BigInt(await near.view(FACTORY, 'get_min_deposit'));
    await ok('1 create_event', host, FACTORY, fc('create_event', { name: NAME, deposit: DEPOSIT.toString(), capacity: 5, windows: { cancel_deadline_ns: cancelNs.toString(), checkin_start_ns: cancelNs.toString(), checkin_end_ns: endNs.toString() } }, min + 50n * MILLI, 150n * TGAS), `${EV}, 0.01 NEAR deposit`);
    await until(async () => near.view(EV, 'get_info'), 30_000);
    for (const g of [gA, gB, gC]) await ok(`1 rsvp ${g.accountId.split('.')[0]}`, g, EV, fc('rsvp', {}, DEPOSIT), 'locked 0.01 NEAR');
  });
  if (fail) throw new Error('setup failed');
  const [skA, skB, skH] = [await signInKey(gA), await signInKey(gB), await signInKey(host)];
  const chain = liveChain(relayer);
  server = serve({ port: PORT, chain, info: { relayer: RELAYER, factory: FACTORY, network: 'testnet' }, relay: createRelay({ factory: FACTORY, relayerId: RELAYER, chain, log: (...a) => log(`#   [relayer] ${a.join(' ').slice(0, 240)}`) }) });
  await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
  RELAY_URL = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

  await step('2 widget signed in (guest A)', async () => {
    const { ctx, errs } = await context(browser, session(GA, skA)); const page = await ctx.newPage();
    await page.goto(`${BASE}/widget/demo.html?event=${EV}&relayer=${encodeURIComponent(RELAY_URL)}`);
    await until(async () => /Cancel RSVP/.test(await widgetText(page)), 30_000, 1000);
    const txt = await widgetText(page);
    check('2 signed-in widget', /Signed in as/.test(txt) && txt.includes(GA) && /Cancel RSVP \(refund 0\.01 NEAR\)/.test(txt), JSON.stringify(txt.replace(/\s+/g, ' ').slice(0, 220)));
    check('2 door pass offered', /Create my signed door pass/.test(txt), 'QR area shows "Create my signed door pass"');
    const before = await stableBal(GA);
    await widgetBtn(page).click();
    await until(async () => /gasless|relayer:|error/i.test(await widgetText(page)), 90_000, 1000);
    const after = await until(async () => (await status(GA)) === null ? stableBal(GA) : null, 60_000);
    const note = (await widgetText(page)).replace(/\s+/g, ' ');
    const hash = await page.evaluate(() => document.querySelector('#live')?.shadowRoot?.querySelector('.note a')?.href?.split('/').pop());
    check('3 gasless Cancel click', /gasless: the relayer paid the gas/.test(note) && after != null, `widget "${note.slice(0, 200)}"`, hash);
    check('3 guest A refunded exactly, paid no gas', after != null && after - before === DEPOSIT, `A balance change ${after != null ? near4(after - before) : '?'}`, hash);
    await until(async () => /RSVP: lock 0\.01 NEAR/.test(await widgetText(page)), 30_000, 1000);
    // rsvp attaches the deposit, so it must go to the wallet: capture the MyNearWallet page and decode the tx it was handed.
    const u = await walletTx(ctx, page, () => widgetBtn(page).click()), raw = u?.searchParams.get('transactions');
    let detail = `wallet ${u ? u.origin + u.pathname : 'not opened'}`, good = false;
    if (raw) {
      const t = N.decodeTransaction(N.fromBase64(decodeURIComponent(raw.split(',')[0]))), a = t.actions[0];
      good = t.signerId === GA && t.receiverId === EV && t.actions.length === 1 && a.type === 'FunctionCall' && a.methodName === 'rsvp' && a.deposit === DEPOSIT;
      detail += `: ${t.signerId} → ${t.receiverId} ${a.methodName}(${new TextDecoder().decode(a.args)}) deposit ${near4(a.deposit)}`;
    }
    check('4 RSVP hands the exact tx to MyNearWallet', good, detail);
    check('4 no page errors', !errs.length, JSON.stringify(errs).slice(0, 300));
    await ctx.close();
  });

  await step('5 relayer down -> wallet fallback (guest B)', async () => {
    const { ctx, errs } = await context(browser, session(GB, skB)); const page = await ctx.newPage();
    await page.goto(`${BASE}/widget/demo.html?event=${EV}&relayer=${encodeURIComponent('http://127.0.0.1:9')}`);
    await until(async () => /Cancel RSVP/.test(await widgetText(page)), 30_000, 1000);
    const before = await stableBal(GB);
    const wallet = walletTx(ctx, page, () => widgetBtn(page).click());
    const res = await Promise.race([wallet.then((u) => u && `MyNearWallet ${u.origin}${u.pathname}`),
      until(async () => (await status(GB)) === null && 'signed in the browser with the sign-in key (guest pays gas)', 45_000, 2000)]);
    await sleep(3000);
    const txt = (await widgetText(page)).replace(/\s+/g, ' ');
    const after = (await status(GB)) === null ? await stableBal(GB) : null;
    check('5 relayer unreachable: cancel falls back to the wallet path', !!res && !/gasless: the relayer/.test(txt), `${res || 'nothing happened'}${after != null ? `; B balance change ${near4(after - before)}` : ''}; widget "${txt.slice(0, 160)}"`);
    check('5 no page errors', !errs.length, JSON.stringify(errs).slice(0, 300));
    await ctx.close();
  });

  await waitUntilNs(cancelNs, 'check-in to open');
  await step('6 door page gasless check_in (host)', async () => {
    const { ctx, errs } = await context(browser, session(HOST, skH)); const page = await ctx.newPage();
    const before = await stableBal(HOST);
    await page.goto(`${BASE}/dashboard/checkin.html?event=${EV}&relayer=${encodeURIComponent(RELAY_URL)}`);
    await until(async () => /Signed in as/.test(await page.locator('#me').innerText()), 30_000, 1000);
    check('6 host signed in on door page', /host/.test(await page.locator('#role').innerText()), (await page.locator('#role').innerText()).replace(/\s+/g, ' ').slice(0, 120));
    await page.locator('#code').fill(GC); await page.locator('#lookup').click();
    await page.locator('#go:not([disabled])').waitFor({ timeout: 30_000 });
    await page.locator('#go').click();
    await until(async () => /CheckedIn ✓|relayer|rror/.test(await page.locator('#result').innerText()), 90_000, 1000);
    const st = await until(async () => (await status(GC)) === 'CheckedIn' || null, 60_000);
    const after = await stableBal(HOST);
    const hash = await page.evaluate(() => document.querySelector('#result a')?.href?.split('/').pop());
    check('6 gasless check_in click', !!st, `guest C ${st ? 'CheckedIn' : 'not checked in'}; page "${(await page.locator('#result').innerText()).replace(/\s+/g, ' ').slice(0, 120)}"`, hash);
    check('6 host paid nothing', after === before, `host balance change ${near4(after - before)}`, hash);
    check('6 no page errors', !errs.length, JSON.stringify(errs).slice(0, 300));
    await ctx.close();
  });

  await waitUntilNs(endNs, 'check-in to close');
  await step('7 settle + dashboard CSV', async () => {
    await ok('7 settle (anyone)', gA, EV, fc('settle', {}, 0n, 100n * TGAS), 'settled');
    await until(async () => (await near.view(EV, 'get_info')).settled, 30_000);
    const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 900 }, isMobile: true }); const page = await ctx.newPage();
    await page.goto(`${BASE}/dashboard/?event=${EV}`);
    await page.getByText('Final payouts (settled)').waitFor({ timeout: 30_000 });
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByText('Export CSV', { exact: true }).click();
    const d = await dl, csv = fs.readFileSync(await d.path(), 'utf8'), rows = csv.trim().split('\r\n');
    const byGuest = Object.fromEntries(rows.slice(1).map((r) => r.split(',')).map((c) => [c[2], c]));
    check('7 CSV download', /^showup-.*-ledger\.csv$/.test(d.suggestedFilename()) && rows.length >= 2, `${d.suggestedFilename()}, ${rows.length - 1} rows: ${rows.slice(1).map((r) => r.split(',').slice(2, 4).join('=')).join(' ')}`);
    check('7 CSV: C attended, paid 0.01', byGuest[GC]?.[3] === 'attended' && byGuest[GC]?.[10] === '0.01', JSON.stringify(byGuest[GC] || null).slice(0, 200));
    await ctx.close();
  });
} catch (e) { check('fatal', false, String(e.stack || e).replace(/\s+/g, ' ').slice(0, 400)); } finally {
  log(`SUMMARY pass ${pass} fail ${fail}`);
  await browser?.close(); server?.close();
  process.exit(fail ? 1 : 0);
}
