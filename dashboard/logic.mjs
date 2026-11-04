// Host dashboard pure logic: guest tallies and payout projection using the contract's settle math.
import { settleMath } from '../lib/settle.mjs';
import { formatNear } from '../widget/core.mjs';

export const OUTCOME = { CheckedIn: 'attendee', Rsvp: 'no-show if not checked in', Cancelled: 'refunded at cancel' };

export function tally(guests) {
  const t = { Rsvp: 0, CheckedIn: 0, Cancelled: 0, total: guests.length };
  for (const [, s] of guests) { if (!(s in t)) throw new Error(`unknown status ${s}`); t[s]++; }
  return t;
}

/** Payouts if settle ran with the current statuses (exact final payouts once settled). */
export function projectPayouts(info, guests) {
  const deposit = BigInt(info.deposit), t = tally(guests);
  const { each, dust } = settleMath(deposit, t.CheckedIn, t.Rsvp);
  const order = { CheckedIn: 0, Rsvp: 1, Cancelled: 2 };
  const rows = [...guests].sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]))
    .map(([account, status]) => ({ account, status, outcome: info.settled && status === 'Rsvp' ? 'no-show: deposit forfeited' : OUTCOME[status], payout: status === 'CheckedIn' ? each : 0n }));
  if (dust > 0n) rows.push({ account: info.host, status: 'host', outcome: t.CheckedIn ? 'rounding dust' : 'no attendees: pool to host', payout: dust });
  const held = deposit * BigInt(t.CheckedIn + t.Rsvp), paid = rows.reduce((s, r) => s + r.payout, 0n);
  return { tally: t, each, dust, held, paid, conserved: held === paid, bonus: t.CheckedIn ? each - deposit : 0n, rows };
}

export const fmtRow = (r) => ({ ...r, payoutNear: formatNear(r.payout, 6) });

// ---- accountant CSV export ----
export const NEARBLOCKS_API = 'https://api-testnet.nearblocks.io/v1';
export const explorerTxUrl = (h) => `https://testnet.nearblocks.io/txns/${h}`;
export const explorerAccountUrl = (a) => `https://testnet.nearblocks.io/address/${a}`;
export const CSV_COLUMNS = ['event', 'network', 'guest_account', 'status', 'rsvp_time_utc', 'deposit_near', 'deposit_tx',
  'refund_near', 'refund_time_utc', 'refund_tx', 'payout_near', 'payout_time_utc', 'payout_tx', 'explorer_url'];

/** RFC 4180: comma separated, CRLF line ends, fields with , " CR LF quoted and " doubled. Cells that a spreadsheet
 * would run as a formula (= + @ tab CR at the start) get a leading apostrophe. */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (columns, rows) => [columns, ...rows.map((r) => columns.map((c) => r[c]))].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const nsToIso = (ns) => (ns == null || ns === '' ? '' : new Date(Number(BigInt(String(ns).split('.')[0]) / 1_000_000n)).toISOString());
const methodsOf = (t) => (t.actions || []).filter((a) => /FUNCTION_CALL/i.test(a.action || '')).map((a) => a.method);
const succeeded = (t) => t.outcomes?.status !== false;

/** Index nearblocks /account/<escrow>/txns rows: latest successful rsvp/cancel per guest, and the settle tx. */
export function indexTxns(escrow, txns = []) {
  const byGuest = {}, sorted = [...txns].filter(succeeded).filter((t) => t.receiver_account_id === escrow)
    .sort((a, b) => (BigInt(String(a.block_timestamp).split('.')[0]) < BigInt(String(b.block_timestamp).split('.')[0]) ? -1 : 1));
  let settle = null;
  for (const t of sorted) {
    const g = t.predecessor_account_id, ms = methodsOf(t);
    const rec = { hash: t.transaction_hash, ns: t.block_timestamp };
    if (ms.includes('rsvp')) (byGuest[g] ??= {}).rsvp = rec;
    if (ms.includes('cancel')) (byGuest[g] ??= {}).cancel = rec;
    if (ms.includes('settle') && !settle) settle = rec;
  }
  return { byGuest, settle };
}

/**
 * One row per guest (plus the host when it receives dust / the unclaimed pool). Amounts are decimal NEAR.
 * payout_* is filled only once the event is settled; missing tx hashes stay blank.
 */
export function ledgerRows(eventId, info, guests, txns = []) {
  const p = projectPayouts(info, guests), idx = indexTxns(eventId, txns), dep = BigInt(info.deposit);
  const near = (y) => formatNear(y, 24);
  const STATUS = { CheckedIn: 'attended', Rsvp: info.settled ? 'no_show_forfeited' : 'rsvp_not_checked_in', Cancelled: 'cancelled_refunded' };
  return p.rows.map((r) => {
    const t = idx.byGuest[r.account] || {}, isHost = r.status === 'host';
    const paid = info.settled && (r.status === 'CheckedIn' || isHost);
    const row = { event: eventId, network: 'near-testnet', guest_account: r.account, status: isHost ? (r.outcome === 'rounding dust' ? 'host_rounding_dust' : 'host_no_attendees_pool') : STATUS[r.status],
      rsvp_time_utc: isHost ? '' : nsToIso(t.rsvp?.ns), deposit_near: isHost ? '' : near(dep), deposit_tx: t.rsvp?.hash || '',
      refund_near: r.status === 'Cancelled' ? near(dep) : '', refund_time_utc: r.status === 'Cancelled' ? nsToIso(t.cancel?.ns) : '', refund_tx: r.status === 'Cancelled' ? t.cancel?.hash || '' : '',
      payout_near: info.settled ? near(r.payout) : '', payout_time_utc: paid ? nsToIso(idx.settle?.ns) : '', payout_tx: paid ? idx.settle?.hash || '' : '' };
    row.explorer_url = row.deposit_tx ? explorerTxUrl(row.deposit_tx) : explorerAccountUrl(r.account);
    return row;
  });
}
export const ledgerCsv = (eventId, info, guests, txns) => toCsv(CSV_COLUMNS, ledgerRows(eventId, info, guests, txns));

/** All txns touching the escrow from the nearblocks testnet API (paged). Returns [] on any failure: tx columns then stay blank. */
export async function fetchEscrowTxns(escrow, { fetchImpl = fetch, base = NEARBLOCKS_API, perPage = 25, maxPages = 8 } = {}) {
  const all = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const r = await fetchImpl(`${base}/account/${encodeURIComponent(escrow)}/txns?page=${page}&per_page=${perPage}&order=asc`, { headers: { accept: 'application/json' } });
      if (!r.ok) break;
      const j = await r.json(), txns = Array.isArray(j?.txns) ? j.txns : [];
      all.push(...txns);
      if (txns.length < perPage) break;
    }
  } catch { /* offline / CORS / rate limit: export without hashes */ }
  return all;
}
