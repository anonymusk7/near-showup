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
