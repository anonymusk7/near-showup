import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as c from '../widget/core.mjs';
const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const D = '100000000000000000000000';
const info = (o = {}) => ({ host: 'h.testnet', deposit: D, capacity: 10, active: 3, cancel_deadline_ns: '100', checkin_start_ns: '200', checkin_end_ns: '300', settled: false, checkers: [], ...o });

test('view request encodes args as base64 JSON', () => {
  const r = c.buildViewRequest('ev.testnet', 'get_status', { account_id: 'a.testnet' });
  assert.equal(r.method, 'query'); assert.equal(r.params.request_type, 'call_function'); assert.equal(r.params.finality, 'final');
  assert.deepEqual(JSON.parse(Buffer.from(r.params.args_base64, 'base64').toString()), { account_id: 'a.testnet' });
});
test('parses recorded testnet RPC responses (settled demo event)', () => {
  const i = c.parseViewResponse(fx('demo-get_info.rpc.json')), g = c.parseViewResponse(fx('demo-get_guests.rpc.json'));
  assert.equal(i.host, 'showup-demo-1793595312.testnet'); assert.equal(i.settled, true); assert.equal(i.deposit, D);
  assert.deepEqual(g, [['guest1-1793595336.testnet', 'CheckedIn'], ['guest2-1793595336.testnet', 'Rsvp']]);
});
test('RPC errors surface', () => {
  assert.throws(() => c.parseViewResponse({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }), /UNKNOWN_ACCOUNT/);
  assert.throws(() => c.parseViewResponse({ result: { error: 'wasm execution failed' } }), /wasm execution/);
  assert.throws(() => c.parseViewResponse({ result: {} }), /malformed/);
});
test('viewCall posts to RPC and decodes', async () => {
  let seen; const f = async (url, o) => { seen = { url, body: JSON.parse(o.body) }; return { ok: true, json: async () => fx('demo-get_info.rpc.json') }; };
  const i = await c.viewCall('showup-demo-1793595312.testnet', 'get_info', {}, { fetchImpl: f });
  assert.equal(seen.url, 'https://rpc.testnet.near.org'); assert.equal(seen.body.params.method_name, 'get_info'); assert.equal(i.capacity, 10);
  await assert.rejects(c.viewCall('x', 'y', {}, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
});
test('viewCall falls back to FastNEAR on -429, network error or HTTP error; explicit rpc is used alone', async () => {
  const ok = { ok: true, json: async () => fx('demo-get_info.rpc.json') };
  for (const fail of [{ ok: true, json: async () => ({ error: { code: -429, message: 'deprecated' } }) }, { ok: false, status: 429 }, null]) {
    const urls = []; const f = async (url) => { urls.push(url); if (urls.length > 1) return ok; if (!fail) throw new TypeError('fetch failed'); return fail; };
    assert.equal((await c.viewCall('a', 'get_info', {}, { fetchImpl: f })).capacity, 10);
    assert.deepEqual(urls, c.RPC_FALLBACKS);
  }
  const urls = []; await assert.rejects(c.viewCall('a', 'b', {}, { rpc: 'https://my.rpc', fetchImpl: async (u) => { urls.push(u); return { ok: false, status: 429 }; } }), /429/);
  assert.deepEqual(urls, ['https://my.rpc']);
  // a contract-level error is an answer, not an outage: no retry on the next RPC
  const seen = []; await assert.rejects(c.viewCall('a', 'b', {}, { fetchImpl: async (u) => { seen.push(u); return { ok: true, json: async () => ({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }) }; } }), /UNKNOWN_ACCOUNT/);
  assert.equal(seen.length, 1);
});
test('formatNear truncates with BigInt precision', () => {
  assert.equal(c.formatNear(D), '0.1'); assert.equal(c.formatNear(10n ** 24n * 5n), '5');
  assert.equal(c.formatNear('1333333333333333333333333'), '1.3333'); assert.equal(c.formatNear('1', 24), '0.000000000000000000000001');
  assert.equal(c.formatNear(0), '0');
});
test('phases and spots left', () => {
  assert.equal(c.phaseOf(info(), 50), 'open'); assert.equal(c.phaseOf(info(), 150), 'closed'); assert.equal(c.phaseOf(info({ checkin_start_ns: '100' }), 100), 'checkin');
  assert.equal(c.phaseOf(info(), 300), 'checkin'); assert.equal(c.phaseOf(info(), 301), 'ended'); assert.equal(c.phaseOf(info({ settled: true }), 50), 'settled');
  const s = c.eventSummary(info(), 50n); assert.equal(s.spotsLeft, 7); assert.equal(s.depositNear, '0.1'); assert.equal(s.canRsvp, true);
  assert.equal(c.eventSummary(info({ active: 10 }), 50n).canRsvp, false); assert.equal(c.eventSummary(info(), 150n).canRsvp, false);
});
test('1Click dry quote request asks for exactly the deposit in wNEAR', async () => {
  let seen; const f = async (url, o) => { seen = { url, body: JSON.parse(o.body) }; return { ok: true, json: async () => fx('oneclick-dry-quote-usdc-base.json') }; };
  const o = c.ORIGINS[0], q = await c.quoteDeposit(o, D, { fetchImpl: f, now: 0 });
  assert.ok(seen.url.endsWith('/v0/quote'));
  assert.deepEqual(seen.body, { dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset: o.asset, depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:wrap.near', amount: D, refundTo: o.refundTo, refundType: 'ORIGIN_CHAIN', recipient: c.PREVIEW_RECIPIENT,
    recipientType: 'DESTINATION_CHAIN', deadline: '1970-01-01T01:00:00.000Z' });
  const s = c.summarizeQuote(q, o);
  assert.match(s.pay, /^[\d.]+ USDC$/); assert.equal(s.receive, '0.1 NEAR'); assert.equal(s.from, 'USDC on Base');
  assert.throws(() => c.summarizeQuote({}, o), /amountIn/);
  await assert.rejects(c.quoteDeposit(o, D, { fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'refundTo is not valid' }) }), /400 refundTo/);
  assert.throws(() => c.buildQuoteRequest({ originAsset: 'x' }), /missing/);
});
test('card renders info and escapes untrusted strings', () => {
  const s = c.eventSummary(info(), 50n), html = c.renderCard('<img src=x onerror=alert(1)>.testnet', s);
  assert.ok(!html.includes('<img')); assert.ok(html.includes('&lt;img'));
  assert.match(html, /data-k="deposit">0\.1 NEAR/); assert.match(html, /data-k="spots">7</); assert.match(html, /RSVP: lock 0\.1 NEAR/);
  const done = c.renderCard('e.testnet', c.eventSummary(info({ settled: true }), 50n));
  assert.match(done, /disabled>Settled/); assert.ok(!done.includes('<select'), 'no quote preview once RSVP is closed'); assert.match(done, /RSVPs are closed/);
  assert.equal((html.match(/<option/g) || []).length, c.ORIGINS.length);
});
test('rsvp CLI command attaches the exact deposit', () => {
  assert.match(c.rsvpCommand('ev.testnet', D), /ev\.testnet rsvp .* attached-deposit '0\.1 NEAR'/);
  assert.match(c.rsvpCommand('ev.testnet', '1000000000000000000000001'), /'1\.000000000000000000000001 NEAR'/);
});

// ---- wallet sign-in + QR check-in ----
const sum = (o = {}) => c.eventSummary(info(o), 50n);
test('guestAction: sign in → RSVP → cancel/QR → checked in', () => {
  assert.equal(c.guestAction(sum(), null, null).kind, 'signin');
  assert.deepEqual(c.guestAction(sum(), null, 'alice.testnet'), { kind: 'rsvp', label: 'RSVP: lock 0.1 NEAR' });
  assert.equal(c.guestAction(sum(), 'Cancelled', 'alice.testnet').kind, 'rsvp', 'a cancelled guest may RSVP again (contract allows it)');
  const cancel = c.guestAction(sum(), 'Rsvp', 'alice.testnet');
  assert.equal(cancel.kind, 'cancel'); assert.match(cancel.label, /refund 0\.1 NEAR/); assert.match(cancel.note, /QR/);
  assert.equal(c.guestAction(sum(), 'CheckedIn', 'alice.testnet').disabled, true);
  assert.equal(c.guestAction(sum({ settled: true }), null, null).kind, 'none');
  assert.equal(c.guestAction(sum({ active: 10 }), null, 'bob.testnet').label, 'Event full');
});
test('check-in QR payload round-trips and rejects junk / wrong event', () => {
  const p = c.checkinPayload('ev.testnet', 'alice.testnet');
  assert.equal(p, 'showup:checkin?event=ev.testnet&guest=alice.testnet');
  assert.deepEqual(c.parseCheckinPayload(p, 'ev.testnet'), { event: 'ev.testnet', guest: 'alice.testnet' });
  assert.deepEqual(c.parseCheckinPayload(' alice.testnet ', 'ev.testnet'), { event: 'ev.testnet', guest: 'alice.testnet' }, 'bare account id is accepted');
  assert.throws(() => c.parseCheckinPayload(p, 'other.testnet'), /not this event/);
  assert.throws(() => c.parseCheckinPayload('https://evil.example/?x'), /not a ShowUp/);
  assert.throws(() => c.parseCheckinPayload('showup:checkin?event=ev.testnet&guest=<script>'), /not a ShowUp|bad account/);
  assert.throws(() => c.checkinPayload('ev.testnet', 'Bad Name'), /bad account/);
});
test('checkinCheck mirrors the contract check_in requires', () => {
  const i = info({ host: 'host.testnet', checkers: ['door.testnet'], checkin_start_ns: '100', checkin_end_ns: '200' });
  const at = (o) => c.checkinCheck(i, { checker: 'door.testnet', status: 'Rsvp', nowNs: 150n, ...o });
  assert.deepEqual(at({}), { ok: true });
  assert.ok(c.checkinCheck(i, { checker: 'host.testnet', status: 'Rsvp', nowNs: 150n }).ok);
  assert.match(at({ checker: null }).reason, /Sign in/);
  assert.match(at({ checker: 'rando.testnet' }).reason, /not the host or a checker/);
  assert.match(at({ nowNs: 99n }).reason, /not opened/);
  assert.match(at({ nowNs: 201n }).reason, /over/);
  assert.match(at({ status: 'CheckedIn' }).reason, /Already/);
  assert.match(at({ status: 'Cancelled' }).reason, /cancelled/);
  assert.match(at({ status: null }).reason, /No RSVP/);
});
test('wallet bundle is lazy: only loaded after a wallet was used or on wallet redirect', () => {
  const store = (o) => ({ getItem: (k) => o[k] ?? null });
  assert.equal(c.walletWasUsed(store({}), ''), false);
  assert.equal(c.walletWasUsed(store({ 'near-wallet-selector:selectedWalletId': '"my-near-wallet"' }), ''), true);
  assert.equal(c.walletWasUsed(store({}), '?account_id=a.testnet&all_keys=x'), true);
  assert.equal(c.walletWasUsed(store({}), '?transactionHashes=abc'), true);
  assert.equal(c.walletWasUsed(undefined, ''), false);
});

test('1Click outage (521 HTML / Failed to fetch) gives a friendly message, not raw HTML', async () => {
  const o = c.ORIGINS[0];
  const err = await c.quoteDeposit(o, D, { fetchImpl: async () => ({ ok: false, status: 521, text: async () => '<!DOCTYPE html><html>Web server is down</html>' }) }).catch((e) => e);
  assert.ok(!err.message.includes('<html')); assert.match(c.friendlyQuoteError(err), /unavailable/);
  assert.match(c.friendlyQuoteError(new TypeError('Failed to fetch')), /unavailable/);
  assert.equal(c.friendlyQuoteError(new Error('1Click quote failed: 400 refundTo is not valid')), '1Click quote failed: 400 refundTo is not valid');
});

test('gaslessCall: null without relayer/key, relays with the browser function-call key, surfaces relayer errors', async () => {
  const N = await import('../lib/nep366.mjs');
  const { b58encode } = await import('../widget/vendor/crypto.js');
  const sk = 'ed25519:' + b58encode(new Uint8Array(32).fill(3));
  const store = { getItem: (k) => (k === 'near-api-js:keystore:g.testnet:testnet' ? sk : null) };
  assert.equal(await c.gaslessCall({ relayer: null, accountId: 'g.testnet', storage: store }), null);
  assert.equal(await c.gaslessCall({ relayer: 'http://r', accountId: 'other.testnet', storage: store, receiverId: 'ev.testnet', methodName: 'cancel' }), null);
  let posted;
  const fetchImpl = async (url, o) => {
    const b = JSON.parse(o.body);
    if (url === 'http://r/relay') { posted = N.decodeSignedDelegateBase64(b.signed_delegate); return { ok: true, status: 200, json: async () => ({ ok: true, hash: 'HX' }) }; }
    return { json: async () => ({ result: b.method === 'block' ? { header: { height: 10 } } : { nonce: 1 } }) };
  };
  assert.deepEqual(await c.gaslessCall({ relayer: 'http://r', accountId: 'g.testnet', storage: store, receiverId: 'ev.testnet', methodName: 'check_in', args: { guest: 'x.testnet' }, fetchImpl }), { hash: 'HX', gasless: true });
  assert.deepEqual([posted.delegateAction.senderId, posted.delegateAction.receiverId, posted.delegateAction.actions[0].methodName, posted.delegateAction.actions[0].deposit], ['g.testnet', 'ev.testnet', 'check_in', 0n]);
  const refusing = async (url, o) => (url.endsWith('/relay') ? { ok: false, status: 403, json: async () => ({ ok: false, error: 'outside check-in window' }) } : fetchImpl(url, o));
  await assert.rejects(c.gaslessCall({ relayer: 'http://r', accountId: 'g.testnet', storage: store, receiverId: 'ev.testnet', methodName: 'cancel', fetchImpl: refusing }), /outside check-in window/);
});
