import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectPayouts, tally, fmtRow, csvCell, toCsv, ledgerRows, ledgerCsv, CSV_COLUMNS, fetchEscrowTxns, indexTxns, explorerTxUrl, explorerAccountUrl, NEARBLOCKS_API, INDEXER_API } from '../dashboard/logic.mjs';
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

// Normalized escrow receipt shape (what fetchEscrowTxns returns from NearBlocks v3 /accounts/<id>/receipts). Hashes are the real ones from docs/testnet-e2e-2026-11-02.log; times are illustrative.
const nb = (hash, from, method, ns, ok = true) => ({ transaction_hash: hash, predecessor_account_id: from, receiver_account_id: 'showup-demo-1793595312.testnet',
  block_timestamp: ns, actions: [{ action: 'FUNCTION_CALL', method }], outcomes: { status: ok } });
const DEMO_TXNS = [
  nb('7ij9J5qUDfXd4iprguGNPmyMbe6KrWvuKwytjVsnR5gr', 'guest1-1793595336.testnet', 'rsvp', '1793595400000000000'),
  nb('BoosPz7CHKaQppN1RgfBH5i82KrSfEtR3RGabsn7SaHe', 'guest2-1793595336.testnet', 'rsvp', '1793595410000000000'),
  nb('JADwcmhU1tFRz3veGoHYLnCz6R6NpC4yGKSv8DGuwNYV', 'showup-demo-1793595312.testnet', 'check_in', '1793595500000000000'),
  nb('FAILEDsettLe11111111111111111111111111111111', 'guest2-1793595336.testnet', 'settle', '1793595590000000000', false),
  nb('5d5HTC8v9vAzPSuhed5MJZsGUypyr5GL6Rr4GkWmyBkT', 'guest2-1793595336.testnet', 'settle', '1793595600000000000'),
];

test('CSV cells follow RFC 4180 and defuse spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain'); assert.equal(csvCell(null), ''); assert.equal(csvCell(0), '0');
  assert.equal(csvCell('a,b'), '"a,b"'); assert.equal(csvCell('say "hi"'), '"say ""hi"""'); assert.equal(csvCell('l1\nl2'), '"l1\nl2"'); assert.equal(csvCell('x\r'), '"x\r"');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"'); assert.equal(csvCell('+1'), "'+1"); assert.equal(csvCell('@a'), "'@a");
  assert.equal(toCsv(['a', 'b'], [{ a: 1, b: 'x,y' }, { a: '', b: undefined }]), 'a,b\r\n1,"x,y"\r\n,\r\n');
});
test('ledger CSV for the settled demo event: one row per guest with deposit/payout txs', () => {
  const csv = ledgerCsv('showup-demo-1793595312.testnet', fx('demo-get_info.rpc.json'), fx('demo-get_guests.rpc.json'), DEMO_TXNS);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(',')); assert.equal(lines[0], 'event,network,guest_account,status,rsvp_time_utc,deposit_near,deposit_tx,refund_near,refund_time_utc,refund_tx,payout_near,payout_time_utc,payout_tx,explorer_url');
  assert.equal(lines.length, 4); assert.equal(lines.at(-1), '');
  assert.equal(lines[1], 'showup-demo-1793595312.testnet,near-testnet,guest1-1793595336.testnet,attended,2026-11-02T04:56:40.000Z,0.1,7ij9J5qUDfXd4iprguGNPmyMbe6KrWvuKwytjVsnR5gr,,,,0.2,2026-11-02T05:00:00.000Z,5d5HTC8v9vAzPSuhed5MJZsGUypyr5GL6Rr4GkWmyBkT,https://testnet.near.rocks/txns/5d5HTC8v9vAzPSuhed5MJZsGUypyr5GL6Rr4GkWmyBkT');
  assert.equal(lines[2], 'showup-demo-1793595312.testnet,near-testnet,guest2-1793595336.testnet,no_show_forfeited,2026-11-02T04:56:50.000Z,0.1,BoosPz7CHKaQppN1RgfBH5i82KrSfEtR3RGabsn7SaHe,,,,0,,,https://testnet.near.rocks/txns/BoosPz7CHKaQppN1RgfBH5i82KrSfEtR3RGabsn7SaHe');
});
test('ledger rows: cancel refunds, unsettled payouts blank, host dust row, missing txs blank', () => {
  const info = { host: 'host.testnet', deposit: (10n ** 24n).toString(), settled: false };
  const g = [['a.testnet', 'CheckedIn'], ['b.testnet', 'Rsvp'], ['c.testnet', 'Cancelled']];
  const txns = [{ transaction_hash: 'CANCELc', predecessor_account_id: 'c.testnet', receiver_account_id: 'ev.testnet', block_timestamp: '1793600000000000000', actions: [{ action: 'FUNCTION_CALL', method: 'cancel' }], outcomes: { status: true } }];
  const rows = ledgerRows('ev.testnet', info, g, txns);
  const c = rows.find((r) => r.guest_account === 'c.testnet');
  assert.deepEqual([c.status, c.refund_near, c.refund_tx, c.refund_time_utc, c.deposit_tx, c.explorer_url], ['cancelled_refunded', '1', 'CANCELc', '2026-11-02T06:13:20.000Z', '', 'https://testnet.near.rocks/txns/CANCELc']);
  assert.ok(rows.filter((r) => r.guest_account !== 'c.testnet').every((r) => r.explorer_url === ''), 'no tx hash: explorer_url stays blank, never an address link');
  assert.ok(rows.every((r) => r.payout_near === '' && r.payout_tx === ''));
  assert.equal(rows.find((r) => r.guest_account === 'b.testnet').status, 'rsvp_not_checked_in');
  const settled = ledgerRows('ev.testnet', { ...info, settled: true }, [['a', 'CheckedIn'], ['b', 'CheckedIn'], ['c', 'CheckedIn'], ['d', 'Rsvp']], []);
  assert.deepEqual(settled.at(-1), { event: 'ev.testnet', network: 'near-testnet', guest_account: 'host.testnet', status: 'host_rounding_dust', rsvp_time_utc: '', deposit_near: '',
    deposit_tx: '', refund_near: '', refund_time_utc: '', refund_tx: '', payout_near: '0.000000000000000000000001', payout_time_utc: '', payout_tx: '', explorer_url: '' });
  assert.equal(settled[0].payout_near, '1.333333333333333333333333');
});
test('explorer helpers point at NEAR Rocks; indexTxns accepts v3 signer_account_id', () => {
  assert.equal(NEARBLOCKS_API, 'https://api-testnet.nearblocks.io/v3'); assert.equal(INDEXER_API, NEARBLOCKS_API);
  assert.equal(explorerTxUrl('H'), 'https://testnet.near.rocks/txns/H'); assert.equal(explorerAccountUrl('a.testnet'), 'https://testnet.near.rocks/accounts/a.testnet');
  const idx = indexTxns('ev.testnet', [{ transaction_hash: 'R', signer_account_id: 'g.testnet', receiver_account_id: 'ev.testnet', block_timestamp: '1', actions: [{ action: 'FUNCTION_CALL', method: 'rsvp' }] }]);
  assert.equal(idx.byGuest['g.testnet'].rsvp.hash, 'R');
});
test('fetchEscrowTxns reads v3 receipts with the meta.next_page cursor, keeps escrow receipts, degrades to [] on errors', async () => {
  const urls = [];
  const rc = (i, o = {}) => ({ transaction_hash: `h${i}`, predecessor_account_id: `g${i}.testnet`, receiver_account_id: 'ev.testnet', included_in_block_timestamp: `${1000 + i}`,
    block: { block_timestamp: `${1000 + i}` }, actions: [{ action: 'FUNCTION_CALL', method: 'cancel' }], outcome: { status: true }, ...o });
  const pages = [
    { data: [rc(0), rc(1, { receiver_account_id: 'g1.testnet', actions: [{ action: 'TRANSFER', method: null }] })], meta: { next_page: 'C1==' } },
    { data: [rc(2, { included_in_block_timestamp: undefined, outcome: { status: false } }), rc(0)], meta: { next_page: 'C2' } },
    { data: [rc(3)], meta: {} },
  ];
  const f = async (u) => { urls.push(u); return { ok: true, json: async () => pages[urls.length - 1] }; };
  const got = await fetchEscrowTxns('ev.testnet', { fetchImpl: f });
  assert.deepEqual(urls, ['https://api-testnet.nearblocks.io/v3/accounts/ev.testnet/receipts?limit=25',
    'https://api-testnet.nearblocks.io/v3/accounts/ev.testnet/receipts?limit=25&next=C1%3D%3D',
    'https://api-testnet.nearblocks.io/v3/accounts/ev.testnet/receipts?limit=25&next=C2']);
  assert.deepEqual(got.map((t) => t.transaction_hash), ['h0', 'h2', 'h3'], 'non-escrow receipts dropped, duplicates removed');
  assert.deepEqual(got[0], { transaction_hash: 'h0', predecessor_account_id: 'g0.testnet', receiver_account_id: 'ev.testnet', block_timestamp: '1000',
    actions: [{ action: 'FUNCTION_CALL', method: 'cancel' }], outcomes: { status: true } });
  assert.equal(got[1].block_timestamp, '1002'); assert.equal(got[1].outcomes.status, false);
  const endless = async () => ({ ok: true, json: async () => ({ data: [rc(Math.random())], meta: { next_page: 'more' } }) });
  let n = 0; await fetchEscrowTxns('ev.testnet', { fetchImpl: async (...a) => { n++; return endless(...a); } }); assert.equal(n, 8, 'at most 8 pages');
  assert.deepEqual(await fetchEscrowTxns('ev.testnet', { fetchImpl: async () => { throw new Error('offline'); } }), []);
  assert.deepEqual(await fetchEscrowTxns('ev.testnet', { fetchImpl: async () => ({ ok: false, status: 410 }) }), []);
});
test('dashboard has an Export CSV button wired to ledgerCsv', () => {
  const h = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  assert.match(h, /<button id="csv" type="button">Export CSV<\/button>/); assert.match(h, /ledgerCsv\(id, info, guests, txns\)/);
});

test('CSV injection: OWASP prefixes (= + - @, after whitespace, tab/CR) are defused; numbers and text are not', () => {
  assert.equal(csvCell("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
  assert.equal(csvCell('+1'), "'+1"); assert.equal(csvCell('-2+3'), "'-2+3"); assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(' =1'), "' =1"); assert.equal(csvCell('\t=1'), "'\t=1"); assert.equal(csvCell('\tplain'), "'\tplain");
  assert.equal(csvCell('\r=1'), '"\'\r=1"'); // still quoted because of the CR
  assert.equal(csvCell('=1,"x"\n'), '"\'=1,""x""\n"');
  for (const ok of ['0.2', '1.333333333333333333333333', '0', 'alice.testnet', 'a-b.testnet', '2026-11-02T05:00:00.000Z', 'note - with dash'])
    assert.equal(csvCell(ok), ok);
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"'); assert.equal(csvCell('a\r\nb'), '"a\r\nb"');
  assert.equal(csvCell('ünïcødé-guest.testnet'), 'ünïcødé-guest.testnet'); assert.equal(csvCell('名前,テスト'), '"名前,テスト"');
  assert.equal(csvCell('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'); // implicit account
});
test('ledger CSV of an empty event is header only (unsettled and settled)', () => {
  const header = CSV_COLUMNS.join(',') + '\r\n';
  const info = { host: 'host.testnet', deposit: D.toString(), settled: false, cancelled: 3 };
  assert.equal(ledgerCsv('ev.testnet', info, [], []), header);
  assert.equal(ledgerCsv('ev.testnet', { ...info, settled: true }, [], []), header);
});
const dash = () => readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
test('dashboard: fits 360px (select/input/tiles shrink, table scrolls), friendly RPC errors, cancelled from get_info', () => {
  const h = dash();
  assert.match(h, /select\{max-width:100%;min-width:0\}/);
  assert.match(h, /input\{[^}]*min-width:0;max-width:100%/); assert.ok(!/min-width:280px/.test(h));
  assert.match(h, /\.tile\{[^}]*flex:1 1 100px;min-width:0/);
  assert.match(h, /<div style="overflow-x:auto"><table>/); assert.match(h, /td\.acct\{word-break:break-all\}/); assert.match(h, /<td class="acct">/);
  assert.match(h, /No guests yet/);
  assert.match(h, /friendlyRpcError\(err\)/); assert.match(h, /<button id="retry" type="button">Retry<\/button>/); assert.ok(!/e\(err\.message\)/.test(h));
  assert.match(h, /info\.cancelled \?\? p\.tally\.Cancelled/);
});
test('checkin.html: bad event and RPC outage show a friendly message + Retry instead of hanging on "Loading…"', () => {
  const h = readFileSync(new URL('../dashboard/checkin.html', import.meta.url), 'utf8');
  assert.ok(!h.includes("throw new Error('bad event')"));
  assert.match(h, /viewCall\(EVENT, 'get_info', \{\}\)\.catch\(\(x\) => halt\(friendlyRpcError\(x\), true\)\)/);
  assert.match(h, /if \(!isAccountId\(EVENT\)\) await halt\(/);
  assert.match(h, /<div class="card" id="fatal" hidden><\/div>/); assert.match(h, /id="retry" type="button">Retry/);
  assert.ok(!/get_status', \{ account_id: guest \}\)\.catch\(\(\) => null\)/.test(h), 'RPC errors must not read as "no RSVP"');
  assert.match(h, /gaslessOrWallet\(/);
  assert.ok(h.includes('gasless: the relayer paid the gas'), 'gasless check-in says the relayer paid the gas');
});
