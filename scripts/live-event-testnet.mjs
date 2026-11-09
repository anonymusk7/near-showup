// Creates a live demo event on the testnet factory, hosted by the demo host, with RSVP open now and door check-in
// opening when RSVP closes. The escrow requires cancel_deadline <= checkin_start, so RSVP/cancel and check-in can't
// overlap: guests RSVP before RSVP_CLOSE, the door checks them in from RSVP_CLOSE until CHECKIN_END.
// Moves testnet NEAR only; no guest is RSVPed. Keys from ~/.near-credentials/testnet (never printed).
// Usage: node scripts/live-event-testnet.mjs [name] [rsvp_close_iso | +minutes] [checkin_end_iso]
//   e.g. node scripts/live-event-testnet.mjs demo-day +45 2026-11-30T18:30:00Z
// FUNDER=<acct>.testnet tops the host up to cover get_min_deposit() + 0.1 NEAR if needed.
import * as N from '../lib/nep366.mjs';
import * as near from '../relayer/near.mjs';
import { TGAS } from '../relayer/policy.mjs';
const FACTORY = 'showup-factory-1793597558.testnet', HOST = 'showup-host-1793597558.testnet';
const [NAME = 'demo-day', closeArg = '+120', endArg = '2026-11-30T18:30:00Z'] = process.argv.slice(2);
const EV = `${NAME}.${FACTORY}`;
const closeMs = closeArg.startsWith('+') ? Date.now() + Number(closeArg.slice(1)) * 60_000 : Date.parse(closeArg);
const endMs = Date.parse(endArg);
if (!(closeMs > Date.now() && endMs > closeMs)) { console.error('need now < rsvp_close < checkin_end'); process.exit(1); }
const ns = (ms) => (BigInt(Math.floor(ms)) * 1_000_000n).toString();
const windows = { cancel_deadline_ns: ns(closeMs), checkin_start_ns: ns(closeMs), checkin_end_ns: ns(endMs) };
const DEPOSIT = 10n ** 23n; // 0.1 NEAR per guest
for (const a of [FACTORY, HOST]) near.assertTestnet(a);
if (await near.view(FACTORY, 'get_event', { name: NAME })) { console.error(`${EV} already exists`); process.exit(1); }
const min = BigInt(await near.view(FACTORY, 'get_min_deposit'));
const need = min + DEPOSIT + 10n ** 23n; // attached + gas headroom
const bal = BigInt((await near.viewAccount(HOST)).amount);
if (bal < need) {
  if (!process.env.FUNDER) { console.error(`host has ${bal} yocto, needs ${need}; set FUNDER=<acct>.testnet`); process.exit(1); }
  near.assertTestnet(process.env.FUNDER);
  const t = await near.sendTx(near.loadKey(process.env.FUNDER), HOST, [N.actions.transfer(need - bal + 10n ** 24n)]);
  console.log('top-up host', t.failures.length ? 'FAILED' : 'ok', t.hash);
  if (t.failures.length) process.exit(1);
}
const r = await near.sendTx(near.loadKey(HOST), FACTORY, [N.actions.functionCall('create_event',
  { name: NAME, deposit: DEPOSIT.toString(), capacity: 25, windows }, 150n * TGAS, min + DEPOSIT)]);
console.log('create_event', EV, r.failures.length ? 'FAILED ' + JSON.stringify(r.failures) : 'ok', r.hash);
console.log('RSVP/cancel until', new Date(closeMs).toISOString(), '| check-in', new Date(closeMs).toISOString(), '→', new Date(endMs).toISOString());
if (r.failures.length) process.exit(1);
