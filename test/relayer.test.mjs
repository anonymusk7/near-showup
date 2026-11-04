import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as N from '../lib/nep366.mjs';
import { checkDelegate, receiverKind, verifyEscrowWithFactory, preflight, TGAS } from '../relayer/policy.mjs';
import { createRelay } from '../relayer/server.mjs';
import { b58encode } from '../widget/vendor/crypto.js';
const fx = JSON.parse(readFileSync(new URL('./fixtures/nep366-nearjs.json', import.meta.url)));
const hex = (u) => Buffer.from(u).toString('hex');
const SK = 'ed25519:' + b58encode(Buffer.from(fx.seed, 'hex'));
const PK = fx.publicKey;
const F = 'showup-factory-1793597558.testnet', EV = `ev.${F}`, H = 1000n;
const ctx = { factory: F, blockHeight: H, relayerId: 'relayer.testnet' };
const sign = (o = {}, acts = [N.actions.functionCall('cancel', {}, 30n * TGAS, 0n)]) =>
  N.signDelegateAction(N.buildDelegateAction({ senderId: 'guest.testnet', receiverId: EV, publicKey: PK, nonce: 5n, maxBlockHeight: H + 100n, actions: acts, ...o }), SK);
const fc = (m, args = {}, gas = 30n * TGAS, dep = 0n) => N.actions.functionCall(m, args, gas, dep);

test('NEP-366 codec matches @near-js/transactions byte-for-byte (recorded vector)', () => {
  const s = N.decodeSignedDelegateBase64(fx.signed_delegate_base64);
  assert.equal(s.delegateAction.senderId, 'guest.testnet'); assert.equal(s.delegateAction.receiverId, `ev.${F}`);
  assert.equal(s.delegateAction.actions[0].methodName, 'cancel'); assert.equal(s.delegateAction.nonce, 7n); assert.equal(s.delegateAction.maxBlockHeight, 123456789n);
  assert.equal(N.publicKeyToString(s.delegateAction.publicKey), PK);
  assert.equal(N.verifySignedDelegate(s), true);
  // the signed message is tag || borsh(DelegateAction)
  const tag = Buffer.alloc(4); tag.writeUInt32LE(N.NEP366_TAG);
  assert.equal(hex(tag) + hex(N.encodeDelegateAction(s.delegateAction)), fx.delegate_action_hex);
  // our signer reproduces near-js's signature (ed25519 is deterministic)
  assert.equal(N.encodeSignedDelegateBase64(N.signDelegateAction(s.delegateAction, SK)), fx.signed_delegate_base64);
  // relayer transaction wrapping it in Action::Delegate
  const tx = { signerId: 'relayer.testnet', publicKey: PK, nonce: 42n, receiverId: 'guest.testnet', blockHash: new Uint8Array(32).fill(9), actions: [N.actions.delegate(s)] };
  assert.equal(hex(N.encodeTransaction(tx)), fx.relayer_tx_hex);
});
test('round-trip: encode -> decode -> encode for every supported action kind', () => {
  const d = N.decodeSignedDelegate(N.encodeSignedDelegate({ delegateAction: { senderId: 'guest.testnet', receiverId: 'evil.testnet', nonce: 8n, maxBlockHeight: 1n,
    publicKey: N.parsePublicKey(PK), actions: N.decodeSignedDelegate(N.encodeSignedDelegate(sign())).delegateAction.actions }, signature: { keyType: 0, data: new Uint8Array(64) } }));
  assert.equal(d.delegateAction.actions[0].type, 'FunctionCall');
  // the near-js vector with Transfer, AddKey (full + function-call), DeleteAccount, DeleteKey, Stake, CreateAccount, DeployContract
  const all = Buffer.from(fx.all_actions_delegate_hex, 'hex').subarray(4);
  const decoded = N.decodeSignedDelegate(Uint8Array.from([...all, 0, ...new Uint8Array(64)])).delegateAction;
  assert.deepEqual(decoded.actions.map((a) => a.type), ['Transfer', 'AddKey', 'AddKey', 'DeleteAccount', 'DeleteKey', 'Stake', 'CreateAccount', 'DeployContract']);
  assert.equal(decoded.actions[2].accessKey.permission.receiverId, 'ev.testnet'); assert.equal(decoded.actions[2].accessKey.permission.allowance, 250n);
  assert.equal(hex(N.encodeDelegateAction(decoded)), hex(all));
  // signed transaction round-trip + hash is sha256 of the unsigned body
  const { bytes, hash } = N.signTransaction({ signerId: 'r.testnet', publicKey: PK, nonce: 1n, receiverId: 'g.testnet', blockHash: new Uint8Array(32), actions: [N.actions.delegate(sign())] }, SK);
  const st = N.decodeSignedTransaction(bytes);
  assert.equal(st.transaction.actions[0].signedDelegate.delegateAction.actions[0].methodName, 'cancel'); assert.equal(typeof hash, 'string');
});
test('decoder rejects garbage, truncation, trailing bytes, nested Delegate', () => {
  const good = N.encodeSignedDelegate(sign());
  assert.throws(() => N.decodeSignedDelegate(good.subarray(0, good.length - 1)), /end of input/);
  assert.throws(() => N.decodeSignedDelegate(Uint8Array.from([...good, 0])), /trailing/);
  assert.throws(() => N.decodeSignedDelegateBase64('not base64!'), /base64/);
  assert.throws(() => N.encodeSignedDelegate(sign({}, [N.actions.delegate(sign())])), /nested/);
});

test('policy accepts gasless cancel and check_in on a factory escrow', () => {
  const c = checkDelegate(sign(), ctx);
  assert.deepEqual([c.ok, c.kind, c.methods], [true, 'escrow', ['cancel']]);
  const k = checkDelegate(sign({}, [fc('check_in', { guest: 'g.testnet' })]), ctx);
  assert.equal(k.ok, true, k.reason);
});
test('policy rejects transfers, keys, account deletion, other actions', () => {
  const bad = [
    [N.actions.transfer(1n), /Transfer is not allowed/],
    [N.actions.addFullAccessKey(PK), /AddKey/],
    [N.actions.deleteKey(PK), /DeleteKey/],
    [N.actions.deleteAccount('evil.testnet'), /DeleteAccount/],
    [N.actions.createAccount(), /CreateAccount/],
    [N.actions.deployContract(new Uint8Array(4)), /DeployContract/],
    [N.actions.stake(1n, PK), /Stake/],
  ];
  for (const [a, re] of bad) assert.match(checkDelegate(sign({}, [a]), ctx).reason, re);
  assert.match(checkDelegate(sign({}, [fc('cancel'), N.actions.transfer(1n)]), ctx).reason, /at most 1/);
  assert.throws(() => sign({}, []), /actions are required/);
  const empty = sign(); empty.delegateAction.actions = []; assert.match(checkDelegate(empty, ctx).reason, /no actions/);
});
test('policy rejects non-allow-listed methods, deposits, bad args and gas', () => {
  assert.match(checkDelegate(sign({}, [fc('settle')]), ctx).reason, /settle is not allowed/);
  assert.match(checkDelegate(sign({}, [fc('rsvp', {}, 30n * TGAS, 10n ** 22n)]), ctx).reason, /rsvp is not allowed/);
  assert.match(checkDelegate(sign({}, [fc('add_checker', { account_id: 'x.testnet' })]), ctx).reason, /not allowed/);
  assert.match(checkDelegate(sign({}, [fc('cancel', {}, 30n * TGAS, 1n)]), ctx).reason, /deposit must be 0/);
  assert.match(checkDelegate(sign({}, [fc('cancel', {}, 51n * TGAS)]), ctx).reason, /gas/);
  assert.match(checkDelegate(sign({}, [fc('cancel', {}, 0n)]), ctx).reason, /gas/);
  assert.match(checkDelegate(sign({}, [fc('cancel', { x: 1 })]), ctx).reason, /no args/);
  assert.match(checkDelegate(sign({}, [fc('check_in', { guest: 'NOT VALID' })]), ctx).reason, /guest/);
  assert.match(checkDelegate(sign({}, [fc('check_in', new TextEncoder().encode('{'))]), ctx).reason, /not JSON/);
  assert.match(checkDelegate(sign({}, [fc('check_in', { guest: 'a'.repeat(600) })]), ctx).reason, /larger/);
  // nothing is allow-listed on the factory itself
  assert.match(checkDelegate(sign({ receiverId: F }, [fc('create_event')]), ctx).reason, /not allowed on factory/);
});
test('policy rejects other receivers (incl. look-alikes and nested sub-accounts)', () => {
  for (const r of ['evil.testnet', `x.y.${F}`, `ev.showup-factory-1793597558.testnet.evil.testnet`, `evshowup-factory-1793597558.testnet`, `-x.${F}`, `Ev.${F}`])
    assert.equal(checkDelegate(sign({ receiverId: r }), ctx).ok, false, r);
  assert.equal(receiverKind(F, F), 'factory'); assert.equal(receiverKind(EV, F), 'escrow'); assert.equal(receiverKind(`a.${F}`, F), null);
  assert.match(checkDelegate(sign(), { ...ctx, factory: 'showup.near' }).reason, /testnet only/);
});
test('policy checks max_block_height, nonce, signature, sender', () => {
  assert.match(checkDelegate(sign({ maxBlockHeight: H }), ctx).reason, /expired/);
  assert.match(checkDelegate(sign({ maxBlockHeight: H + 5000n }), ctx).reason, /blocks ahead/);
  assert.match(checkDelegate(sign({ nonce: 0n }), ctx).reason, /nonce/);
  const s = sign(); s.signature.data[0] ^= 1; assert.match(checkDelegate(s, ctx).reason, /signature/);
  const t = sign(); t.delegateAction.receiverId = `ev2.${F}`; assert.match(checkDelegate(t, ctx).reason, /signature/); // tampered after signing
  assert.match(checkDelegate(sign({ senderId: 'relayer.testnet' }), ctx).reason, /relayer/);
});
test('factory verification and pre-flight', async () => {
  const view = async (a, m, args) => (args.name === 'ev' ? { account_id: EV, host: 'h.testnet' } : null);
  assert.equal((await verifyEscrowWithFactory(EV, F, view)).ok, true);
  assert.equal((await verifyEscrowWithFactory(`zz.${F}`, F, view)).ok, false);
  const info = { host: 'h.testnet', checkers: ['c.testnet'], cancel_deadline_ns: '100', checkin_start_ns: '100', checkin_end_ns: '200', settled: false };
  assert.equal(preflight({ method: 'cancel', sender: 'g', info, status: 'Rsvp', nowNs: 50 }).ok, true);
  assert.match(preflight({ method: 'cancel', sender: 'g', info, status: 'Rsvp', nowNs: 100 }).reason, /deadline/);
  assert.match(preflight({ method: 'cancel', sender: 'g', info, status: null, nowNs: 50 }).reason, /no active RSVP/);
  assert.equal(preflight({ method: 'check_in', sender: 'c.testnet', args: { guest: 'g' }, info, status: 'Rsvp', nowNs: 150 }).ok, true);
  assert.match(preflight({ method: 'check_in', sender: 'g', args: { guest: 'g' }, info, status: 'Rsvp', nowNs: 150 }).reason, /not the host/);
  assert.match(preflight({ method: 'check_in', sender: 'h.testnet', args: { guest: 'g' }, info, status: 'Rsvp', nowNs: 99 }).reason, /window/);
  assert.match(preflight({ method: 'check_in', sender: 'h.testnet', args: { guest: 'g' }, info: { ...info, settled: true }, status: 'Rsvp', nowNs: 150 }).reason, /settled/);
});
test('relay handler: sends accepted actions once, rejects others without sending', async () => {
  const sent = [];
  const chain = { blockHeight: async () => H, nowNs: () => 50n, send: async (s) => { sent.push(s); return { hash: 'HASH', failures: [] }; },
    view: async (a, m, args) => m === 'get_event' ? (args.name === 'ev' ? { account_id: EV } : null)
      : m === 'get_info' ? { host: 'h', cancel_deadline_ns: '100', checkin_start_ns: '100', checkin_end_ns: '200', settled: false } : 'Rsvp' };
  const relay = createRelay({ factory: F, relayerId: 'relayer.testnet', chain });
  const body = { signed_delegate: N.encodeSignedDelegateBase64(sign()) };
  const [st, ok] = await relay(body);
  assert.equal(st, 200); assert.equal(ok.hash, 'HASH'); assert.equal(ok.explorer, 'https://testnet.nearblocks.io/txns/HASH');
  const [st2, again] = await relay(body); // replay / client retry: same answer, not sent again
  assert.deepEqual([st2, again.hash, again.replayed], [200, 'HASH', true]);
  const [both1, both2] = await Promise.all([relay({ signed_delegate: N.encodeSignedDelegateBase64(sign({ nonce: 6n })) }), relay({ signed_delegate: N.encodeSignedDelegateBase64(sign({ nonce: 6n })) })]);
  assert.deepEqual([both1[0], both2[0], both2[1].replayed], [200, 200, true]); // concurrent duplicates share one send
  assert.equal((await relay({ signed_delegate: N.encodeSignedDelegateBase64(sign({}, [N.actions.transfer(1n)])) }))[0], 403);
  assert.equal((await relay({ signed_delegate: N.encodeSignedDelegateBase64(sign({ receiverId: `zz.${F}`, nonce: 9n })) }))[0], 403); // not a factory event
  assert.equal((await relay({ signed_delegate: 'AAAA' }))[0], 400);
  assert.equal(sent.length, 2);
});
test('client helper builds nonce/height from RPC and POSTs base64 to the relayer', async () => {
  const calls = [];
  const fetchImpl = async (url, o) => {
    const b = JSON.parse(o.body); calls.push([url, b]);
    if (url.endsWith('/relay')) { assert.equal(N.decodeSignedDelegateBase64(b.signed_delegate).delegateAction.nonce, 11n); return { ok: true, status: 200, json: async () => ({ ok: true, hash: 'H' }) }; }
    return { json: async () => ({ result: b.method === 'block' ? { header: { height: 500 } } : { nonce: 10, permission: 'FullAccess' } }) };
  };
  const s = await N.signedDelegateCall({ senderId: 'guest.testnet', secretKey: SK, receiverId: EV, methodName: 'cancel', fetchImpl });
  assert.equal(s.delegateAction.maxBlockHeight, 620n); assert.equal(N.verifySignedDelegate(s), true);
  assert.equal((await N.relaySignedDelegate('http://r/', s, { fetchImpl })).hash, 'H');
  await assert.rejects(N.relaySignedDelegate('http://r', s, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'nope' }) }) }), /relayer: nope/);
  const store = { getItem: (k) => (k === 'near-api-js:keystore:guest.testnet:testnet' ? SK : null) };
  assert.equal(N.browserFunctionCallKey(store, 'guest.testnet'), SK); assert.equal(N.browserFunctionCallKey(store, 'x.testnet'), null);
});
