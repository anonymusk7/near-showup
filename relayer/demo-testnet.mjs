// Live TESTNET demo of the gasless relayer (pnpm relayer:demo). Moves testnet NEAR only.
//  1. faucet accounts: relayer, host, two guests (near CLI; falls back to existing keychain accounts)
//  2. host creates an event through the factory; both guests RSVP and pay the deposit themselves
//  3. policy rejections over HTTP (transfer, foreign receiver, nonzero deposit): nothing is sent
//  4. guest A cancels GASLESS through the relayer: balance goes up by exactly the deposit
//  5. once check-in opens, the host checks guest B in GASLESS through the relayer
// Writes docs/testnet-relayer-<date>.log. Never prints private keys.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import * as N from '../lib/nep366.mjs';
import * as near from './near.mjs';
import { createRelay, liveChain, serve, DEFAULT_FACTORY, explorerTx } from './server.mjs';
import { TGAS } from './policy.mjs';
import { formatNear } from '../widget/core.mjs';

const FACTORY = process.env.FACTORY || DEFAULT_FACTORY, NEAR = process.env.NEAR_CLI || path.join(os.homedir(), '.local/bin/near');
const CANCEL_S = Number(process.env.CANCEL_S || 150), CHECKIN_S = Number(process.env.CHECKIN_S || 900);
const T = Math.floor(Date.now() / 1000), DEPOSIT = 10n ** 22n; // 0.01 NEAR
const logFile = path.resolve(import.meta.dirname, '..', 'docs', `testnet-relayer-${new Date().toISOString().slice(0, 10)}.log`);
const lines = [];
const log = (...a) => { const s = a.join(' '); console.log(s); lines.push(s); fs.writeFileSync(logFile, lines.join('\n') + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (a) => BigInt((await near.viewAccount(a)).amount);
const fmtDelta = (d) => `${d < 0n ? '-' : '+'}${formatNear(d < 0n ? -d : d, 24)} NEAR (${d} yocto)`;
const keyFile = (a) => path.join(os.homedir(), '.near-credentials', 'testnet', `${a}.json`);

function faucet(id, fallback) {
  if (fs.existsSync(keyFile(id))) return id;
  try {
    execFileSync(NEAR, ['account', 'create-account', 'sponsor-by-faucet-service', id, 'autogenerate-new-keypair', 'save-to-legacy-keychain',
      'network-config', 'testnet', 'create'], { stdio: 'pipe', timeout: 90_000 });
    if (fs.existsSync(keyFile(id))) { log(`faucet account created: ${id}`); return id; }
  } catch (e) { log(`faucet failed for ${id}: ${String(e.stderr || e.message).split('\n').find((l) => /error|Error/.test(l)) || 'unknown error'}`); }
  log(`using existing keychain account ${fallback} instead of ${id}`);
  return fallback;
}
async function waitAccount(id) { for (let i = 0; i < 20; i++) { try { return await near.viewAccount(id); } catch { await sleep(2000); } } throw new Error(`${id} not visible`); }
async function direct(label, signer, receiver, acts) {
  const r = await near.sendTx(signer, receiver, acts);
  log(`${label}: tx ${r.hash} ${r.failures.length ? 'FAILED ' + JSON.stringify(r.failures[0].failure) : 'ok'}  ${explorerTx(r.hash)}`);
  if (r.failures.length) throw new Error(`${label} failed`);
  return r;
}
async function post(url, signed) {
  const r = await fetch(url + '/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: N.encodeSignedDelegateBase64(signed) }) });
  return [r.status, await r.json()];
}

log(`# ShowUp gasless relayer (NEP-366) live run, NEAR TESTNET, ${new Date().toISOString()}`);
log(`factory ${FACTORY}; RPC ${near.RPCS[0]}`);
const relayerId = faucet(process.env.RELAYER_ACCOUNT || `showup-relayer-${T}.testnet`, 'showup-demo-1793595312.testnet');
const hostId = faucet(`showup-rhost-${T}.testnet`, 'showup-host-1793597558.testnet');
const gA = faucet(`showup-rguest-a-${T}.testnet`, 'guest1-1793595336.testnet');
const gB = faucet(`showup-rguest-b-${T}.testnet`, 'guest2-1793595336.testnet');
for (const a of [relayerId, hostId, gA, gB]) await waitAccount(a);
const [relayer, host, guestA, guestB] = [relayerId, hostId, gA, gB].map((a) => near.loadKey(a));
log(`relayer ${relayerId}  host ${hostId}  guest A ${gA}  guest B ${gB}`);

// 2. event via the factory
const name = `gasless-${T}`, ev = `${name}.${FACTORY}`;
const nowNs = BigInt(Date.now()) * 1_000_000n, cancelNs = nowNs + BigInt(CANCEL_S) * 1_000_000_000n;
const windows = { cancel_deadline_ns: cancelNs.toString(), checkin_start_ns: cancelNs.toString(), checkin_end_ns: (cancelNs + BigInt(CHECKIN_S) * 1_000_000_000n).toString() };
const minDep = BigInt(await near.view(FACTORY, 'get_min_deposit'));
await direct(`create_event ${ev} (host ${hostId} attaches ${formatNear(minDep + 10n ** 23n)} NEAR)`, host, FACTORY,
  [N.actions.functionCall('create_event', { name, deposit: DEPOSIT.toString(), capacity: 10, windows }, 150n * TGAS, minDep + 10n ** 23n)]);
log(`windows: cancel until ${new Date(Number(cancelNs / 1_000_000n)).toISOString()}, check-in until ${new Date(Number(BigInt(windows.checkin_end_ns) / 1_000_000n)).toISOString()}`);
await direct(`rsvp ${gA} (guest pays 0.01 NEAR + own gas)`, guestA, ev, [N.actions.functionCall('rsvp', {}, 30n * TGAS, DEPOSIT)]);
await direct(`rsvp ${gB} (guest pays 0.01 NEAR + own gas)`, guestB, ev, [N.actions.functionCall('rsvp', {}, 30n * TGAS, DEPOSIT)]);

// relayer over HTTP, exactly as browsers reach it
const srvLog = (...a) => log('  [relayer]', ...a);
const server = serve({ port: 0, relay: createRelay({ factory: FACTORY, relayerId, chain: liveChain(relayer), log: srvLog }), info: { relayer: relayerId, factory: FACTORY } });
await new Promise((r) => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}`;
log(`relayer listening on ${url}`);

// 3. rejections (nothing reaches the chain)
const head = BigInt((await near.finalBlock()).header.height);
const akA = await near.rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: gA, public_key: guestA.publicKey });
const mk = (receiverId, acts) => N.signDelegateAction(N.buildDelegateAction({ senderId: gA, receiverId, publicKey: guestA.publicKey, nonce: BigInt(akA.nonce) + 1n, maxBlockHeight: head + 100n, actions: acts }), guestA.secretKey);
for (const [label, s] of [
  ['transfer 1 NEAR to the relayer', mk(relayerId, [N.actions.transfer(10n ** 24n)])],
  ['AddKey full access on the guest', mk(gA, [N.actions.addFullAccessKey(relayer.publicKey)])],
  ['cancel on a non-factory receiver', mk('showup-demo-1793595312.testnet', [N.actions.functionCall('cancel', {}, 30n * TGAS, 0n)])],
  ['rsvp with 0.01 NEAR attached', mk(ev, [N.actions.functionCall('rsvp', {}, 30n * TGAS, DEPOSIT)])],
  ['cancel with 1 yocto attached', mk(ev, [N.actions.functionCall('cancel', {}, 30n * TGAS, 1n)])],
  ['settle (not allow-listed)', mk(ev, [N.actions.functionCall('settle', {}, 30n * TGAS, 0n)])],
  ['check_in signed by a guest (pre-flight)', mk(ev, [N.actions.functionCall('check_in', { guest: gB }, 30n * TGAS, 0n)])],
]) { const [st, j] = await post(url, s); log(`reject check: ${label} -> HTTP ${st} ${j.error}`); if (st === 200) throw new Error('policy let a bad action through'); }

// 4. gasless cancel
const [a0, r0] = [await bal(gA), await bal(relayerId)];
const sCancel = await N.signedDelegateCall({ senderId: gA, secretKey: guestA.secretKey, receiverId: ev, methodName: 'cancel', rpc: near.RPCS[0] });
const cancel = await N.relaySignedDelegate(url, sCancel);
await sleep(4000);
const [a1, r1] = [await bal(gA), await bal(relayerId)];
log(`GASLESS cancel by ${gA}: tx ${cancel.hash}  ${explorerTx(cancel.hash)}`);
log(`  guest A balance ${formatNear(a0, 6)} -> ${formatNear(a1, 6)} NEAR: ${fmtDelta(a1 - a0)} (deposit is ${formatNear(DEPOSIT)} NEAR)`);
log(`  relayer balance delta ${fmtDelta(r1 - r0)}; tokens burnt for gas ${formatNear(BigInt(cancel.tokens_burnt_yocto), 8)} NEAR`);
log(`  guest A status: ${await near.view(ev, 'get_status', { account_id: gA })}`);
const cancelOk = a1 - a0 >= DEPOSIT;

// 5. gasless check_in once the window opens
const waitMs = Number(cancelNs / 1_000_000n) - Date.now() + 8000;
if (waitMs > 0) { log(`waiting ${Math.round(waitMs / 1000)} s for check-in to open…`); await sleep(waitMs); }
const [h0, r2] = [await bal(hostId), await bal(relayerId)];
const sCheck = await N.signedDelegateCall({ senderId: hostId, secretKey: host.secretKey, receiverId: ev, methodName: 'check_in', args: { guest: gB }, rpc: near.RPCS[0] });
const check = await N.relaySignedDelegate(url, sCheck);
await sleep(4000);
const [h1, r3] = [await bal(hostId), await bal(relayerId)];
log(`GASLESS check_in of ${gB} signed by host ${hostId}: tx ${check.hash}  ${explorerTx(check.hash)}`);
log(`  host balance delta ${fmtDelta(h1 - h0)}; relayer balance delta ${fmtDelta(r3 - r2)}`);
log(`  guest B status: ${await near.view(ev, 'get_status', { account_id: gB })}`);
const [st, j] = await post(url, sCheck); log(`replay of the same signed check_in -> HTTP ${st}, replayed=${j.replayed}, hash ${j.hash} (no second tx)`);
server.close();
log(`summary: ${JSON.stringify({ event: ev, relayer: relayerId, host: hostId, guestA: gA, guestB: gB, cancel_tx: cancel.hash, check_in_tx: check.hash,
  guestA_delta_yocto: (a1 - a0).toString(), host_delta_yocto: (h1 - h0).toString(), cancel_gasless: cancelOk, checkin_gasless: h1 >= h0 })}`);
log(`log written to ${path.relative(path.resolve(import.meta.dirname, '..'), logFile)}`);
