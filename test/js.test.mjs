import { test } from 'node:test'; import assert from 'node:assert/strict';
import { settleMath } from '../lib/settle.mjs'; import { getQuote, getStatus } from '../lib/oneclick.mjs';
test('settle matches contract vectors', () => {
  const D = 10n ** 24n;
  assert.deepEqual(settleMath(D, 3, 1), { each: D + D / 3n, dust: 1n });
  assert.deepEqual(settleMath(D, 0, 3), { each: 0n, dust: 3n * D });
});
test('settle conserves funds', () => { for (let i = 0; i < 2000; i++) {
  const d = BigInt(1 + Math.floor(Math.random() * 1e12)), a = Math.floor(Math.random() * 100), n = Math.floor(Math.random() * 100);
  const { each, dust } = settleMath(d, a, n); assert.equal(each * BigInt(a) + dust, d * BigInt(a + n)); } });
test('1Click quote sends dry quote body', async () => {
  let seen; const f = async (url, o) => { seen = { url, body: JSON.parse(o.body) }; return { ok: true, json: async () => ({ quote: { amountOut: '1' } }) }; };
  const q = await getQuote({ originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', amount: '1000000', recipient: 'event.showup.testnet' }, f);
  assert.equal(seen.body.dry, true); assert.ok(seen.url.endsWith('/quote')); assert.equal(q.quote.amountOut, '1');
});
test('1Click quote errors', async () => {
  await assert.rejects(getQuote({}, async () => ({})), /missing/);
  await assert.rejects(getQuote({ originAsset: 'a', destinationAsset: 'b', amount: 1, recipient: 'r' }, async () => ({ ok: false, status: 400, text: async () => 'bad' })), /400/);
  const s = await getStatus('0xabc', async (u) => ({ ok: true, json: async () => ({ status: 'SUCCESS', u }) })); assert.equal(s.status, 'SUCCESS');
});
