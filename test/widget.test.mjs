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
