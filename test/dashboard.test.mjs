import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectPayouts, tally, fmtRow } from '../dashboard/logic.mjs';
import { parseViewResponse } from '../widget/core.mjs';
import { resolvePath } from '../scripts/serve.mjs';
const fx = (n) => parseViewResponse(JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url))));
const D = 10n ** 24n;

test('settled demo event: attendee gets both deposits', () => {
  const p = projectPayouts(fx('demo-get_info.rpc.json'), fx('demo-get_guests.rpc.json'));
  assert.deepEqual(p.tally, { Rsvp: 1, CheckedIn: 1, Cancelled: 0, total: 2 });
  assert.equal(p.each, 2n * 10n ** 23n); assert.equal(p.dust, 0n); assert.equal(p.conserved, true);
  assert.deepEqual(p.rows.map(fmtRow).map((r) => [r.account, r.status, r.payoutNear]),
    [['guest1-1793595336.testnet', 'CheckedIn', '0.2'], ['guest2-1793595336.testnet', 'Rsvp', '0']]);
  assert.equal(p.rows[1].outcome, 'no-show: deposit forfeited');
});
test('matches contract full_flow vector: 3 attend, 1 no-show, 1 cancel, 1 yocto dust', () => {
  const info = { host: 'host.testnet', deposit: D.toString() };
  const g = [['a', 'CheckedIn'], ['b', 'CheckedIn'], ['c', 'CheckedIn'], ['d', 'Rsvp'], ['e', 'Cancelled']];
  const p = projectPayouts(info, g);
  assert.equal(p.each, D + D / 3n); assert.equal(p.dust, 1n); assert.equal(p.paid, 4n * D); assert.equal(p.conserved, true);
  assert.deepEqual(p.rows.at(-1), { account: 'host.testnet', status: 'host', outcome: 'rounding dust', payout: 1n });
  assert.equal(p.rows.find((r) => r.account === 'e').payout, 0n); assert.equal(p.bonus, D / 3n);
});
test('nobody attends: pool goes to host', () => {
  const p = projectPayouts({ host: 'h', deposit: '5' }, [['a', 'Rsvp'], ['b', 'Rsvp']]);
  assert.equal(p.rows.at(-1).payout, 10n); assert.equal(p.rows.at(-1).outcome, 'no attendees: pool to host'); assert.equal(p.bonus, 0n);
});
test('empty guest list and unknown status', () => {
  const p = projectPayouts({ host: 'h', deposit: '5' }, []); assert.equal(p.rows.length, 0); assert.equal(p.conserved, true);
  assert.throws(() => tally([['a', 'Weird']]), /unknown status/);
});
test('conservation holds for random guest mixes', () => {
  const S = ['Rsvp', 'CheckedIn', 'Cancelled'];
  for (let i = 0; i < 500; i++) {
    const d = BigInt(1 + Math.floor(Math.random() * 1e15)), n = Math.floor(Math.random() * 60);
    const g = Array.from({ length: n }, (_, k) => [`g${k}`, S[Math.floor(Math.random() * 3)]]);
    assert.equal(projectPayouts({ host: 'h', deposit: d.toString() }, g).conserved, true);
  }
});
test('static server only serves widget/dashboard/lib', () => {
  assert.equal(resolvePath('/'), null);
  assert.ok(resolvePath('/widget/widget.js').endsWith('/widget/widget.js'));
  assert.ok(resolvePath('/dashboard/').endsWith('/dashboard/index.html'));
  for (const bad of ['/.env', '/.git/config', '/target/x', '/widget/../.env', '/%2e%2e/etc/passwd', '/lib/.hidden']) assert.equal(resolvePath(bad), undefined, bad);
});

test('checkin.html: Look up cannot submit/reload before the module loads', () => {
  const h = readFileSync(new URL('../dashboard/checkin.html', import.meta.url), 'utf8');
  const form = h.match(/<form id="manual"[^>]*>.*?<\/form>/s)[0];
  assert.match(form, /onsubmit="return false"/); assert.match(form, /<button type="button" id="lookup"[^>]*disabled/);
  assert.match(h, /\$\('lookup'\)\.disabled = false/);
});

test('1Click proxy forwards dry quotes and maps outages to a JSON 502', async () => {
  const { proxyQuote } = await import('../scripts/serve.mjs');
  const { Readable } = await import('node:stream');
  const run = async (body, fetchImpl, method = 'POST') => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, url: '/api/1click/quote' });
    const res = { writeHead(s, h) { this.status = s; this.h = h; }, end(b) { this.body = b; } };
    await proxyQuote(req, res, fetchImpl); return res;
  };
  const ok = await run({ dry: true }, async () => new Response('{"quote":{}}', { status: 200, headers: { 'content-type': 'application/json' } }));
  assert.equal(ok.status, 200); assert.equal(ok.h['access-control-allow-origin'], '*'); assert.equal(ok.body, '{"quote":{}}');
  const down = await run({ dry: true }, async () => new Response('<html>521</html>', { status: 521 }));
  assert.equal(down.status, 502); assert.match(JSON.parse(down.body).error, /521/);
  const unreachable = await run({ dry: true }, async () => { throw new Error('fetch failed'); });
  assert.equal(unreachable.status, 502);
  assert.equal((await run({ dry: false }, async () => assert.fail('must not forward'))).status, 400);
});
