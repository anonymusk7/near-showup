// Simulated event: 5 RSVPs, 1 timely cancel, 3 check-ins, 1 no-show. Same rules as the contract.
import { settleMath } from '../lib/settle.mjs';
const YOCTO = 10n ** 24n, deposit = 5n * YOCTO; // 5 NEAR (stand-in for $X USDC)
const fmt = (y) => (Number(y / 10n ** 18n) / 1e6).toFixed(6);
const guests = Object.fromEntries(['alice','bob','carol','dave','erin'].map(g => [`${g}.testnet`, 'Rsvp']));
console.log(`Event deposit: ${fmt(deposit)} NEAR, 5 RSVPs`);
guests['erin.testnet'] = 'Cancelled'; console.log('erin cancels before deadline -> refunded', fmt(deposit));
for (const g of ['alice','bob','carol']) guests[`${g}.testnet`] = 'CheckedIn';
const att = Object.keys(guests).filter(g => guests[g] === 'CheckedIn');
const ns = Object.keys(guests).filter(g => guests[g] === 'Rsvp');
const { each, dust } = settleMath(deposit, att.length, ns.length);
console.log(`check-ins: ${att.length}, no-shows: ${ns.length} (${ns.join(', ')})\n`);
console.table([...att.map(a => ({ account: a, role: 'attendee', payout_NEAR: fmt(each) })),
  ...ns.map(a => ({ account: a, role: 'no-show', payout_NEAR: fmt(0n) })),
  { account: 'host.testnet', role: 'dust', payout_NEAR: (dust).toString() + ' yocto' }]);
const total = each * BigInt(att.length) + dust;
console.log(`conservation: paid ${fmt(total)} == held ${fmt(deposit * BigInt(att.length + ns.length))} -> ${total === deposit * BigInt(att.length + ns.length)}`);
