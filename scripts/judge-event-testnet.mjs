// One-off (2026-11-09): creates the long-lived judge demo event on the testnet factory so the widget shows
// "RSVP open" during judging (cancel deadline 20 Dec 2026), and RSVPs one guest so the dashboard has a row.
// Already run: create_event BVjF2GP4oxUd7DvM8NYkECv9YfFWJ2N85XbsWrSn1X7Y, rsvp 34VqUrhsq1UgHcqVbUeDVo2W2jzQHd1PbysLXkMCPjQu.
// Moves testnet NEAR only. Usage: node scripts/judge-event-testnet.mjs [name]   (keys from ~/.near-credentials/testnet; never printed)
import * as N from '../lib/nep366.mjs';
import * as near from '../relayer/near.mjs';
import { TGAS } from '../relayer/policy.mjs';
const FACTORY = 'showup-factory-1793597558.testnet', HOST = 'showup-host-1793597558.testnet', GUEST = 'showup-guest-1793597596.testnet';
const NAME = process.argv[2] || 'judges-2026', EV = `${NAME}.${FACTORY}`;
const ns = (iso) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();
const windows = { cancel_deadline_ns: ns('2026-12-20T00:00:00Z'), checkin_start_ns: ns('2026-12-20T00:00:00Z'), checkin_end_ns: ns('2026-12-21T00:00:00Z') };
const DEPOSIT = 10n ** 23n; // 0.1 NEAR
for (const a of [FACTORY, HOST, GUEST]) near.assertTestnet(a);
const min = BigInt(await near.view(FACTORY, 'get_min_deposit'));
const fc = (m, args, deposit = 0n, gas = 30n * TGAS) => [N.actions.functionCall(m, args, gas, deposit)];
let r = await near.sendTx(near.loadKey(HOST), FACTORY, fc('create_event', { name: NAME, deposit: DEPOSIT.toString(), capacity: 25, windows }, min + 10n ** 23n, 150n * TGAS));
console.log('create_event', r.failures.length ? 'FAILED ' + JSON.stringify(r.failures) : 'ok', r.hash);
if (r.failures.length) process.exit(1);
r = await near.sendTx(near.loadKey(GUEST), EV, fc('rsvp', {}, DEPOSIT));
console.log('rsvp', GUEST, r.failures.length ? 'FAILED ' + JSON.stringify(r.failures) : 'ok', r.hash);
