// LIVE TESTNET abuse / scenario run (pnpm scenarios:testnet). Moves testnet NEAR only; reuses existing keychain accounts
// (no faucet, no new top-level accounts) and the deployed factory. Every check prints one line
//   PASS|FAIL <scenario>: <detail> <explorer link>
// and the run ends with "SUMMARY pass N fail M" (exit 1 if any FAIL). Expected-failure txs pass when the on-chain
// failure contains the expected panic text. Log: docs/testnet-scenarios-<date>.log (+ .csv). Never prints private keys.
// Env: CANCEL_S (150) and CHECKIN_S (150): cancel deadline = now + CANCEL_S, check-in window = [deadline, deadline + CHECKIN_S].
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs'; import path from 'node:path';
import * as N from '../lib/nep366.mjs';
import * as near from '../relayer/near.mjs';
import { createRelay, liveChain, serve, explorerTx } from '../relayer/server.mjs';
import { TGAS } from '../relayer/policy.mjs';
import { ed25519, b58encode } from '../widget/vendor/crypto.js';
import { formatNear } from '../widget/core.mjs';
import { ledgerCsv, ledgerRows, projectPayouts, CSV_COLUMNS } from '../dashboard/logic.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FACTORY = 'showup-factory-1793597558.testnet';
const HOST = 'showup-rhost-1793775606.testnet', GA = 'showup-rguest-a-1793775606.testnet', GB = 'showup-rguest-b-1793775606.testnet';
const GC = 'showup-guest-1793597596.testnet', OUTSIDER = 'showup-rguest-a-1793775045.testnet', RELAYER = 'showup-relayer-1793775606.testnet';
const CANCEL_S = Number(process.env.CANCEL_S || 150), CHECKIN_S = Number(process.env.CHECKIN_S || 150);
const T = Math.floor(Date.now() / 1000), DEPOSIT = 10n ** 22n, NEAR = 10n ** 24n, MILLI = 10n ** 21n; // 0.01 NEAR deposit
const date = new Date().toISOString().slice(0, 10);
const logFile = path.join(ROOT, 'docs', `testnet-scenarios-${date}.log`), csvFile = path.join(ROOT, 'docs', `testnet-scenarios-${date}.csv`);

const lines = []; let pass = 0, fail = 0;
const log = (s) => { console.log(s); lines.push(s); fs.writeFileSync(logFile, lines.join('\n') + '\n'); };
const check = (sc, ok, detail, hash) => { ok ? pass++ : fail++; log(`${ok ? 'PASS' : 'FAIL'} ${sc}: ${detail}${hash ? ' ' + explorerTx(hash) : ''}`); return ok; };
async function step(sc, fn) { try { await fn(); } catch (e) { check(sc, false, `exception: ${String(e.message || e).replace(/\s+/g, ' ').slice(0, 300)}`); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (x) => JSON.stringify(x).slice(0, 220);
const near4 = (y) => `${y < 0n ? '-' : ''}${formatNear(y < 0n ? -y : y, 24)} NEAR`;
const bal = async (a) => BigInt((await near.viewAccount(a)).amount);
const blockNs = async () => BigInt((await near.finalBlock()).header.timestamp_nanosec);
const head = async () => BigInt((await near.finalBlock()).header.height);
const info = () => near.view(EV, 'get_info');
const status = (a) => near.view(EV, 'get_status', { account_id: a });
const fc = (m, args = {}, deposit = 0n, gas = 30n * TGAS) => [N.actions.functionCall(m, args, gas, deposit)];
/** Poll until fn() is truthy (returns its value) or the timeout passes (returns the last value). */
async function until(fn, timeoutMs = 60_000, everyMs = 2000) {
  const end = Date.now() + timeoutMs; let v;
  for (;;) { v = await fn().catch(() => undefined); if (v || Date.now() > end) return v; await sleep(everyMs); }
}
/** Balance once late gas/deposit refunds have landed: two equal reads 3 s apart. */
async function stableBal(a) { let b = await bal(a); for (let i = 0; i < 10; i++) { await sleep(3000); const c = await bal(a); if (c === b) return b; b = c; } return b; }
/** Balance after it moved away from `before` (then re-read until stable). */
async function balAfter(a, before, timeoutMs = 60_000) { await until(async () => (await bal(a)) !== before, timeoutMs); return stableBal(a); }
async function waitChain(ns, what) {
  log(`# waiting for ${what} (${new Date(Number(ns / 1_000_000n)).toISOString()})…`);
  for (;;) {
    const bt = await blockNs().catch(() => 0n), local = BigInt(Date.now()) * 1_000_000n; // contract uses block time, relayer pre-flight local time
    if (bt >= ns && local >= ns + 2_000_000_000n) return;
    await sleep(Math.min(10_000, Math.max(2000, Number((ns - (bt || local)) / 1_000_000n))));
  }
}

async function expectOk(sc, signer, receiver, acts, detail) {
  const r = await near.sendTx(signer, receiver, acts);
  check(sc, !r.failures.length, r.failures.length ? `tx FAILED ${short(r.failures[0].failure)}` : detail, r.hash);
  return r;
}
async function expectPanic(sc, signer, receiver, acts, text) {
  const r = await near.sendTx(signer, receiver, acts), f = JSON.stringify(r.failures.map((x) => x.failure));
  check(sc, r.failures.length > 0 && f.includes(text), r.failures.length ? `failed${f.includes(text) ? ' as expected' : ' with the WRONG reason'} (want "${text}"): ${f.slice(0, 220)}` : `tx unexpectedly SUCCEEDED (want "${text}")`, r.hash);
  return r;
}
/** Signs a DelegateAction as `k` (or with a foreign seed/pk). nonce = key nonce + 1, max_block_height = final + 100 by default. */
async function delegate(k, receiverId, acts, { nonce, mbh, seed, publicKey } = {}) {
  nonce ??= BigInt((await near.accessKey(k.accountId, k.publicKey)).nonce) + 1n;
  mbh ??= (await head()) + 100n;
  return N.signDelegateAction(N.buildDelegateAction({ senderId: k.accountId, receiverId, publicKey: publicKey ?? k.publicKey, nonce, maxBlockHeight: mbh, actions: acts }), seed ?? k.secretKey);
}
const bodyOf = (sda) => JSON.stringify({ signed_delegate: N.encodeSignedDelegateBase64(sda) });
async function post(url, body) {
  const r = await fetch(url + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : bodyOf(body), signal: AbortSignal.timeout(180_000) });
  return [r.status, await r.json().catch(() => ({}))];
}
const getJson = async (u) => (await fetch(u, { signal: AbortSignal.timeout(90_000) })).json();
const newKey = () => { const seed = new Uint8Array(randomBytes(32)); return { seed, publicKey: 'ed25519:' + b58encode(ed25519.getPublicKey(seed)) }; };

// ---------------------------------------------------------------------------------------------------------------------
for (const a of [FACTORY, HOST, GA, GB, GC, OUTSIDER, RELAYER]) near.assertTestnet(a);
const [host, gA, gB, gC, outsider, relayer] = [HOST, GA, GB, GC, OUTSIDER, RELAYER].map((a) => near.loadKey(a));
log(`# ShowUp scenario run, NEAR TESTNET, ${new Date().toISOString()}; factory ${FACTORY}; RPC ${near.RPCS[0]}; CANCEL_S=${CANCEL_S} CHECKIN_S=${CHECKIN_S}`);
log(`# host ${HOST}  A ${GA}  B ${GB}  C ${GC}  outsider ${OUTSIDER}  relayer ${RELAYER}`);
log(`# balances: ${(await Promise.all([HOST, GA, GB, GC, OUTSIDER, RELAYER].map(async (a) => `${a.split('.')[0]}=${formatNear(await bal(a))}`))).join(' ')}`);
const NAME = `scen-${T}`, EV = `${NAME}.${FACTORY}`;
let deadlineNs, endNs, storageAfterRsvp, url, server, brokeServer, child;
const beforeDeadline = async (sc, marginS = 10) => (await blockNs()) + BigInt(marginS) * 1_000_000_000n < deadlineNs
  || (check(sc, false, `skipped: the cancel deadline is (nearly) past, raise CANCEL_S (now ${CANCEL_S})`), false);

await step('1 factory rejects capacity 201', async () => {
  const before = await stableBal(HOST), now = BigInt(Date.now()) * 1_000_000n, s = now + 600n * 1_000_000_000n;
  const r = await expectPanic('1 factory rejects capacity 201', host, FACTORY, fc('create_event', { name: `scen-cap-${T}`, deposit: DEPOSIT.toString(), capacity: 201,
    windows: { cancel_deadline_ns: s.toString(), checkin_start_ns: s.toString(), checkin_end_ns: (s + 600n * 1_000_000_000n).toString() } }, 24n * NEAR / 10n, 150n * TGAS), 'capacity must be at most 200');
  const after = await until(async () => { const b = await bal(HOST); return before - b < NEAR ? b : null; }, 60_000) ?? await bal(HOST); // wait for the 2.4 NEAR refund receipt
  const lost = before - after;
  check('1 host keeps the 2.4 NEAR', lost < 50n * MILLI, `host balance change ${near4(-lost)} (gas only; tokens burnt ${near4(near.tokensBurnt(r.res))})`, r.hash);
});

await step('2 create event', async () => {
  const minDep = BigInt(await near.view(FACTORY, 'get_min_deposit'));
  deadlineNs = BigInt(Date.now()) * 1_000_000n + BigInt(CANCEL_S) * 1_000_000_000n; endNs = deadlineNs + BigInt(CHECKIN_S) * 1_000_000_000n;
  const windows = { cancel_deadline_ns: deadlineNs.toString(), checkin_start_ns: deadlineNs.toString(), checkin_end_ns: endNs.toString() };
  await expectOk('2 create event', host, FACTORY, fc('create_event', { name: NAME, deposit: DEPOSIT.toString(), capacity: 3, windows }, minDep + 50n * MILLI, 150n * TGAS),
    `${EV} capacity 3, deposit 0.01 NEAR, attached ${formatNear(minDep + 50n * MILLI)} NEAR; cancel until ${new Date(Number(deadlineNs / 1_000_000n)).toISOString()}, check-in until ${new Date(Number(endNs / 1_000_000n)).toISOString()}`);
  const i = await until(info, 30_000), rec = await near.view(FACTORY, 'get_event', { name: NAME });
  check('2 get_info', i?.capacity === 3 && i.cancelled === 0 && i.host === HOST && i.active === 0 && rec?.account_id === EV,
    `capacity ${i?.capacity} cancelled ${i?.cancelled} active ${i?.active} host ${i?.host}; factory record ${rec?.account_id} https://testnet.nearblocks.io/address/${EV}`);
});

await step('3 rsvp', async () => {
  for (const [n, k] of [['A', gA], ['B', gB], ['C', gC]]) await expectOk(`3 rsvp ${n}`, k, EV, fc('rsvp', {}, DEPOSIT), `${k.accountId} locked exactly 0.01 NEAR`);
  const o0 = await stableBal(OUTSIDER);
  await expectPanic('3 rsvp deposit-1 yocto', outsider, EV, fc('rsvp', {}, DEPOSIT - 1n), 'attach exactly');
  await expectPanic('3 double rsvp by A', gA, EV, fc('rsvp', {}, DEPOSIT), 'already RSVPed');
  await expectPanic('3 rsvp when full (3/3)', outsider, EV, fc('rsvp', {}, DEPOSIT), 'event full');
  const lost = o0 - (await until(async () => { const b = await bal(OUTSIDER); return o0 - b < DEPOSIT / 2n ? b : null; }, 60_000) ?? await bal(OUTSIDER)); // refunds land a few blocks later
  check('3 outsider deposits refunded', lost < DEPOSIT / 2n, `outsider net change ${near4(-lost)} across both failed rsvps (gas only)`);
  const i = await until(async () => { const x = await info(); return x.active === 3 ? x : null; }, 30_000);
  storageAfterRsvp = BigInt((await near.viewAccount(EV)).storage_usage);
  check('3 state after rsvps', i?.active === 3, `active ${i?.active}/3; escrow storage_usage ${storageAfterRsvp} bytes`);
});

await step('4 relayer up', async () => {
  const chain = liveChain(relayer);
  server = serve({ port: 3031, chain, info: { relayer: RELAYER, factory: FACTORY, network: 'testnet' },
    relay: createRelay({ factory: FACTORY, relayerId: RELAYER, chain, log: (...a) => log(`#   [relayer] ${a.join(' ').slice(0, 300)}`) }) });
  await new Promise((ok, ko) => { server.once('listening', ok); server.once('error', ko); });
  url = 'http://127.0.0.1:3031';
  const h = await getJson(url + '/health');
  check('4 /health', h.balance_yocto != null && h.low_funds === false && h.rpc === 'ok', `rpc ${h.rpc}, balance ${h.balance_near} NEAR, low_funds ${h.low_funds}`);
});

let cancelBody, cancelHash, c1;
await step('5 gasless cancel by C', async () => {
  if (!(await beforeDeadline('5 gasless cancel by C'))) return;
  const c0 = await stableBal(GC), sda = await delegate(gC, EV, fc('cancel'));
  cancelBody = bodyOf(sda);
  const [st, j] = await post(url, cancelBody); cancelHash = j.hash;
  check('5 relayer accepts C cancel', st === 200 && j.ok === true, `HTTP ${st} ${j.error || `relayer burnt ${near4(BigInt(j.tokens_burnt_yocto || 0))}`}`, j.hash);
  if (st !== 200) return;
  c1 = await balAfter(GC, c0);
  check('5 C refunded exactly 0.01 NEAR', c1 - c0 === DEPOSIT, `C balance change ${near4(c1 - c0)} (${c1 - c0} yocto), C paid no gas`, j.hash);
  const i = await until(async () => { const x = await info(); return x.cancelled === 1 ? x : null; }, 30_000), s = await status(GC);
  const storage = BigInt((await near.viewAccount(EV)).storage_usage);
  check('5 entry freed', s === null && i?.cancelled === 1 && i.active === 2 && storage < storageAfterRsvp,
    `get_status(C) ${s}, cancelled ${i?.cancelled}, active ${i?.active}, storage_usage ${storageAfterRsvp} -> ${storage} bytes`);
});

await step('13 relayer out of funds', async () => {
  if (!(await beforeDeadline('13 relayer out of funds', 20))) return;
  const brokeId = `broke-${T}.${RELAYER}`, k = newKey(); // key lives in memory only
  let created = null;
  for (const amt of [185n * 10n ** 19n, 2n * MILLI]) { // 0.00185 NEAR, then 0.002 NEAR: just its storage
    const r = await near.sendTx(relayer, brokeId, [N.actions.createAccount(), N.actions.transfer(amt), N.actions.addFullAccessKey(k.publicKey)]);
    if (!r.failures.length) { created = { amt, hash: r.hash }; break; }
    log(`# create ${brokeId} with ${formatNear(amt, 6)} NEAR failed: ${short(r.failures[0].failure)} ${explorerTx(r.hash)}`);
  }
  if (!check('13 broke sub-account', !!created, created ? `${brokeId} funded with ${formatNear(created.amt, 6)} NEAR (storage only)` : 'could not create', created?.hash)) return;
  const broke = { accountId: brokeId, publicKey: k.publicKey, secretKey: k.seed };
  await until(() => near.accessKey(brokeId, k.publicKey), 30_000);
  const chain = liveChain(broke);
  brokeServer = serve({ port: 0, chain, info: { relayer: brokeId, factory: FACTORY, network: 'testnet' },
    relay: createRelay({ factory: FACTORY, relayerId: brokeId, chain, log: (...a) => log(`#   [broke relayer] ${a.join(' ').slice(0, 300)}`) }) });
  await new Promise((ok) => brokeServer.once('listening', ok));
  const bUrl = `http://127.0.0.1:${brokeServer.address().port}`;
  const [st, j] = await post(bUrl, await delegate(gB, EV, fc('cancel')));
  check('13 503 RELAYER_OUT_OF_FUNDS', st === 503 && j.code === 'RELAYER_OUT_OF_FUNDS' && j.retryable === false, `HTTP ${st} code ${j.code}: ${j.error}`);
  check('13 nothing sent for B', (await status(GB)) === 'Rsvp', `get_status(B) still ${await status(GB)}`);
  const h = await getJson(bUrl + '/health');
  check('13 /health low_funds', h.low_funds === true, `balance ${h.balance_near} NEAR, low_funds ${h.low_funds}`);
  brokeServer.close();
});

await step('6 replay', async () => {
  if (!cancelBody) return check('6 replay', false, 'no cancel body from step 5');
  const before = await stableBal(GC), [st, j] = await post(url, cancelBody);
  await sleep(5000);
  const after = await bal(GC);
  check('6 replay returns the first result', st === 200 && j.replayed === true && j.hash === cancelHash && after === before,
    `HTTP ${st} replayed ${j.replayed}, hash ${j.hash === cancelHash ? 'same' : j.hash}, C balance change ${near4(after - before)}`, j.hash);
});

await step('7 relayer refusals', async () => {
  const r0 = await stableBal(RELAYER), aNonce = BigInt((await near.accessKey(GA, gA.publicKey)).nonce), h = await head(), rnd = newKey();
  const cases = [
    ['C cancels again', () => delegate(gC, EV, fc('cancel')), /no active RSVP/, true],
    ['random key (not on-chain)', () => delegate(gA, EV, fc('cancel'), { seed: rnd.seed, publicKey: rnd.publicKey, nonce: 1n }), /not an access key/],
    ['used nonce', () => delegate(gA, EV, fc('cancel'), { nonce: aNonce }), /nonce already used/],
    ['expired max_block_height', () => delegate(gA, EV, fc('cancel'), { mbh: h - 1n }), /expired/],
    ['method settle', () => delegate(gA, EV, fc('settle')), /settle is not allowed/],
    ['receiver evil.testnet', () => delegate(gA, 'evil.testnet', fc('cancel')), /is not the factory/],
    ['receiver lookalike', () => delegate(gA, `${NAME}.${FACTORY.replace('.testnet', '-x.testnet')}`, fc('cancel')), /is not the factory/],
    ['receiver non-factory event', () => delegate(gA, 'showup-demo-1793595312.testnet', fc('cancel')), /is not the factory/],
    ['escrow name not in factory', () => delegate(gA, `nope-${T}.${FACTORY}`, fc('cancel')), /not an event created by/],
    ['rsvp with deposit', () => delegate(gA, EV, fc('rsvp', {}, DEPOSIT)), /not allowed|deposit must be 0/],
    ['transfer action', () => delegate(gA, EV, [N.actions.transfer(NEAR)]), /Transfer is not allowed/],
  ];
  for (const [label, mk, want, needsDeadline] of cases) {
    if (needsDeadline && !(await beforeDeadline(`7 refuse: ${label}`, 3))) continue;
    const [st, j] = await post(url, await mk());
    check(`7 refuse: ${label}`, st === 403 && want.test(j.error || ''), `HTTP ${st} ${j.error}`);
  }
  await sleep(3000);
  const r1 = await bal(RELAYER);
  check('7 relayer paid nothing', r1 === r0, `relayer balance change ${near4(r1 - r0)} across the refusals`);
});

await step('8 before check-in', async () => {
  if ((await blockNs()) + 15_000_000_000n < deadlineNs) await expectPanic('8 direct check_in before window', host, EV, fc('check_in', { guest: GA }), 'outside check-in window');
  else check('8 direct check_in before window', false, `skipped: check-in already open, raise CANCEL_S (now ${CANCEL_S})`);
  await waitChain(deadlineNs + 3_000_000_000n, 'check-in to open');
});

await step('9 in the window', async () => {
  const h0 = await stableBal(HOST), [st, j] = await post(url, await delegate(host, EV, fc('check_in', { guest: GA })));
  check('9 gasless check_in of A by host', st === 200 && j.ok === true, `HTTP ${st} ${j.error || 'ok'}`, j.hash);
  const s = await until(async () => ((await status(GA)) === 'CheckedIn' ? 'CheckedIn' : null), 30_000);
  await sleep(3000);
  const h1 = await bal(HOST);
  check('9 host paid nothing', h1 === h0 && s === 'CheckedIn', `get_status(A) ${s}; host balance change ${h1 - h0} yocto`, j.hash);
  const [st2, j2] = await post(url, await delegate(host, EV, fc('check_in', { guest: GA })));
  check('9 gasless double check_in refused', st2 === 403 && /no active RSVP/.test(j2.error || ''), `HTTP ${st2} ${j2.error}`);
  await expectPanic('9 direct double check_in', host, EV, fc('check_in', { guest: GA }), 'guest has no active RSVP');
  const [st3, j3] = await post(url, await delegate(gB, EV, fc('check_in', { guest: GB })));
  check('9 gasless self check_in by B refused', st3 === 403 && /not the host/.test(j3.error || ''), `HTTP ${st3} ${j3.error}`);
  await expectPanic('9 direct check_in by outsider', outsider, EV, fc('check_in', { guest: GB }), 'not authorized');
  await expectPanic('9 cancel by A after check-in', gA, EV, fc('cancel'), 'cancellation deadline passed');
  await expectPanic('9 cancel by B after deadline', gB, EV, fc('cancel'), 'deadline passed');
  await expectPanic('9 settle before end', outsider, EV, fc('settle', {}, 0n, 100n * TGAS), 'event not over');
  if ((await blockNs()) > endNs) check('9 timing', false, `the check-in window closed during step 9, raise CHECKIN_S (now ${CHECKIN_S})`);
});

await step('10 after the window', async () => {
  await waitChain(endNs + 3_000_000_000n, 'check-in to close');
  await expectPanic('10 direct check_in of B after window', host, EV, fc('check_in', { guest: GB }), 'outside check-in window');
});

let settleHash;
await step('11 settle', async () => {
  const a0 = await stableBal(GA);
  const r = await expectOk('11 settle by outsider', outsider, EV, fc('settle', {}, 0n, 100n * TGAS), 'anyone may settle once check-in is over'); settleHash = r.hash;
  const a1 = await balAfter(GA, a0);
  check('11 A paid exactly 0.02 NEAR', a1 - a0 === 2n * DEPOSIT, `A balance change ${near4(a1 - a0)} (${a1 - a0} yocto): own deposit + B's forfeited deposit, no dust`, r.hash);
  await expectPanic('11 re-settle', outsider, EV, fc('settle', {}, 0n, 100n * TGAS), 'already settled');
});

await step('12 csv ledger', async () => {
  const i = await until(async () => { const x = await info(); return x.settled ? x : null; }, 30_000), guests = await near.view(EV, 'get_guests');
  const csv = ledgerCsv(EV, i, guests, []), rows = ledgerRows(EV, i, guests, []), p = projectPayouts(i, guests);
  fs.writeFileSync(csvFile, csv);
  const by = Object.fromEntries(rows.map((r) => [r.guest_account, r]));
  check('12 csv header', csv.split('\r\n')[0] === CSV_COLUMNS.join(','), csv.split('\r\n')[0]);
  check('12 csv CRLF', csv.endsWith('\r\n') && !/[^\r]\n/.test(csv), `${csv.split('\r\n').length - 1} CRLF-terminated lines`);
  check('12 A attended 0.02', by[GA]?.status === 'attended' && by[GA]?.payout_near === '0.02', `A ${by[GA]?.status} payout ${by[GA]?.payout_near}`);
  check('12 B forfeited', by[GB]?.status === 'no_show_forfeited' && by[GB]?.payout_near === '0', `B ${by[GB]?.status} payout ${by[GB]?.payout_near}`);
  check('12 no row for C', !by[GC] && rows.length === 2, `rows: ${rows.map((r) => `${r.guest_account}=${r.status}`).join(', ')} (C's entry was freed at cancel)`);
  check('12 conservation', p.conserved && p.dust === 0n, `held ${near4(p.held)} paid ${near4(p.paid)} dust ${p.dust}; written ${path.relative(ROOT, csvFile)}`, settleHash);
});

await step('14 rpc outage', async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'relayer/server.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RELAYER_ACCOUNT: RELAYER, NEAR_RPC: 'http://127.0.0.1:9', PORT: '3032' } });
  await new Promise((ok, ko) => { const t = setTimeout(() => ko(new Error('child relayer did not start')), 20_000);
    child.stdout.on('data', (d) => { if (/ShowUp relayer on/.test(d)) { clearTimeout(t); ok(); } }); child.once('exit', (c) => ko(new Error(`child exited ${c}`))); });
  const h = await getJson('http://127.0.0.1:3032/health');
  check('14 /health rpc unreachable', h.rpc === 'unreachable' && h.balance_yocto === null, `rpc ${h.rpc}, balance ${h.balance_yocto}`);
  const [st, j] = await post('http://127.0.0.1:3032', await delegate(gA, EV, fc('cancel'))); // well-formed; the relayer can't reach NEAR
  check('14 relay 503 retryable', st === 503 && j.retryable === true, `HTTP ${st} retryable ${j.retryable}: ${j.error}`);
});

child?.kill(); server?.close(); brokeServer?.close();
log(`# event ${EV}; log ${path.relative(ROOT, logFile)}`);
log(`SUMMARY pass ${pass} fail ${fail}`);
process.exit(fail ? 1 : 0);
