import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as N from '../lib/nep366.mjs';
import { checkDelegate, checkAccessKey, receiverKind, verifyEscrowWithFactory, preflight, TGAS } from '../relayer/policy.mjs';
import { createRelay, friendlySendError, health, isRpcDown, RPC_DOWN_ERROR } from '../relayer/server.mjs';
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
const mockChain = (o = {}) => ({ blockHeight: async () => H, nowNs: () => 50n, accessKey: async () => ({ nonce: 0, permission: 'FullAccess' }),
  send: async () => assert.fail('must not send'),
  view: async (a, m, args) => m === 'get_event' ? (args.name === 'ev' ? { account_id: EV } : null)
    : m === 'get_info' ? { host: 'h', cancel_deadline_ns: '100', checkin_start_ns: '100', checkin_end_ns: '200', settled: false } : 'Rsvp', ...o });
const body = (o, acts) => ({ signed_delegate: N.encodeSignedDelegateBase64(sign(o, acts)) });
test('relay handler: sends accepted actions once, rejects others without sending', async () => {
  const sent = [];
  const chain = mockChain({ send: async (s) => { sent.push(s); return { hash: 'HASH', failures: [] }; } });
  const relay = createRelay({ factory: F, relayerId: 'relayer.testnet', chain });
  const b = body();
  const [st, ok] = await relay(b);
  assert.equal(st, 200); assert.equal(ok.hash, 'HASH'); assert.equal(ok.explorer, 'https://testnet.near.rocks/txns/HASH');
  const [st2, again] = await relay(b); // replay / client retry: same answer, not sent again
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
  // Wallet Selector 10 MyNearWallet: {privateKey, contractId, methods} under `functionCallKey` + `signedAccountId` (the legacy entry is removed)
  const ws10 = (acct, fk) => ({ getItem: (k) => (k === 'signedAccountId' ? acct : k === 'functionCallKey' ? JSON.stringify(fk) : null) });
  const fk = { privateKey: SK, contractId: EV, methods: [] };
  assert.equal(N.browserFunctionCallKey(ws10('guest.testnet', fk), 'guest.testnet', 'testnet', EV), SK);
  assert.equal(N.browserFunctionCallKey(ws10('guest.testnet', fk), 'guest.testnet'), SK);
  assert.equal(N.browserFunctionCallKey(ws10('guest.testnet', fk), 'guest.testnet', 'testnet', 'other.testnet'), null, 'key scoped to another contract');
  assert.equal(N.browserFunctionCallKey(ws10('other.testnet', fk), 'guest.testnet', 'testnet', EV), null, 'signed in as someone else');
  assert.equal(N.browserFunctionCallKey(ws10('guest.testnet', { ...fk, privateKey: 'junk' }), 'guest.testnet'), null);
  assert.equal(N.browserFunctionCallKey({ getItem: (k) => (k === 'functionCallKey' ? '{bad json' : null) }, 'guest.testnet'), null);
  // decodeTransaction round-trips the unsigned tx the wallet is handed
  const tx = { signerId: 'guest.testnet', publicKey: N.parseSecretKey(SK).publicKey, nonce: 7n, receiverId: EV, blockHash: new Uint8Array(32).fill(1), actions: [N.actions.functionCall('rsvp', {}, 30n * 10n ** 12n, 10n ** 22n)] };
  const back = N.decodeTransaction(N.encodeTransaction(tx));
  assert.deepEqual([back.signerId, back.receiverId, back.nonce, back.actions[0].methodName, back.actions[0].deposit], ['guest.testnet', EV, 7n, 'rsvp', 10n ** 22n]);
});

test('checkAccessKey: key must be on sender, nonce unused, FC key scoped to receiver + method', () => {
  const d = sign().delegateAction; // nonce 5, receiver EV, method cancel
  assert.equal(checkAccessKey({ nonce: 4, permission: 'FullAccess' }, d).ok, true);
  assert.match(checkAccessKey(null, d).reason, /not an access key of guest\.testnet/);
  assert.match(checkAccessKey({ nonce: 5, permission: 'FullAccess' }, d).reason, /nonce already used \(replay\)/);
  assert.match(checkAccessKey({ nonce: '9', permission: 'FullAccess' }, d).reason, /replay/);
  const fc = (receiver_id, method_names) => ({ nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id, method_names } } });
  assert.equal(checkAccessKey(fc(EV, []), d).ok, true, 'empty method_names = any method');
  assert.equal(checkAccessKey(fc(EV, ['rsvp', 'cancel']), d).ok, true);
  assert.match(checkAccessKey(fc(`other.${F}`, []), d).reason, /key is for other\./);
  assert.match(checkAccessKey(fc(EV, ['rsvp']), d).reason, /does not allow cancel/);
});
test('relay: random-key sender, used nonce, wrong FC key are rejected without sending (403)', async () => {
  const keys = {
    'random key': async () => null,
    'replay after restart': async () => ({ nonce: 5, permission: 'FullAccess' }), // signed nonce 5 already used on-chain
    'FC key for another receiver': async () => ({ nonce: 0, permission: { FunctionCall: { receiver_id: `zz.${F}`, method_names: [] } } }),
    'FC key without the method': async () => ({ nonce: 0, permission: { FunctionCall: { receiver_id: EV, method_names: ['rsvp'] } } }),
  };
  const asked = [];
  for (const [name, accessKey] of Object.entries(keys)) {
    const relay = createRelay({ factory: F, relayerId: 'relayer.testnet', chain: mockChain({ accessKey: async (a, pk) => { asked.push([a, pk]); return accessKey(); } }) });
    const [st, r] = await relay(body());
    assert.equal(st, 403, name); assert.equal(r.ok, false); assert.ok(r.error, name);
  }
  assert.deepEqual(asked[0], ['guest.testnet', PK]);
});
test('relay: RPC outage before sending -> 503 retryable, nothing sent, not cached', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  for (const o of [{ blockHeight: down }, { accessKey: down }, { view: down }, { view: async (a, m) => (m === 'get_event' ? { account_id: EV } : down()) }]) {
    const relay = createRelay({ factory: F, relayerId: 'relayer.testnet', chain: mockChain(o) });
    const [st, r] = await relay(body());
    assert.deepEqual([st, r], [503, { ok: false, error: RPC_DOWN_ERROR, retryable: true }], Object.keys(o).join());
  }
  // after the outage the same signed action goes through (the 503 wasn't cached as a replay)
  let up = false, sent = 0;
  const relay = createRelay({ factory: F, relayerId: 'relayer.testnet', chain: mockChain({ blockHeight: async () => { if (!up) throw new Error('connect ECONNREFUSED'); return H; },
    send: async () => { sent++; return { hash: 'H2', failures: [] }; } }) });
  assert.equal((await relay(body()))[0], 503); up = true;
  const [st, r] = await relay(body()); assert.deepEqual([st, r.hash, r.replayed, sent], [200, 'H2', undefined, 1]);
  // an RPC *answer* (e.g. escrow has no contract) stays a 403 policy rejection
  const answer = Object.assign(new Error('RPC query: CodeDoesNotExist'), { rpc: { name: 'HANDLER_ERROR' } });
  assert.equal(isRpcDown(answer), false); assert.equal(isRpcDown(Object.assign(new Error('x'), { unreachable: true })), true);
  assert.equal(isRpcDown(new Error('view of ev-500.testnet failed')), false);
});
test('relay: relayer out of funds -> 503 RELAYER_OUT_OF_FUNDS; other send errors stay 502', async () => {
  const broke = new Error('RPC send_tx: {"name":"INVALID_TRANSACTION","info":{"InvalidTransaction":{"NotEnoughBalance":{"signer_id":"relayer.testnet","balance":"1","cost":"2"}}}}');
  const relay = createRelay({ factory: F, relayerId: 'relayer.testnet', chain: mockChain({ send: async () => { throw broke; } }) });
  const [st, r] = await relay(body());
  assert.equal(st, 503);
  assert.deepEqual(r, { ok: false, retryable: false, code: 'RELAYER_OUT_OF_FUNDS',
    error: 'The gasless relayer is out of testnet NEAR; nothing was charged to you. Use your wallet instead (or top up relayer.testnet).' });
  assert.equal(friendlySendError(new Error('LackBalanceForState {"account_id":"relayer.testnet"}'), 'relayer.testnet').code, 'RELAYER_OUT_OF_FUNDS');
  assert.equal(friendlySendError(new Error('NotEnoughBalance {"signer_id":"someone.testnet"}'), 'relayer.testnet'), null);
  assert.equal(friendlySendError(new Error('Transaction nonce 5 must be larger'), 'relayer.testnet'), null);
  const other = createRelay({ factory: F, relayerId: 'relayer.testnet', chain: mockChain({ send: async () => { throw new Error('boom'); } }) });
  assert.deepEqual(await other(body()), [502, { ok: false, error: 'boom' }]);
});
test('health reports relayer balance, low funds, and survives an RPC outage', async () => {
  const info = { relayer: 'relayer.testnet', factory: F, network: 'testnet' };
  assert.deepEqual(await health(info, { balance: async () => '3' + '0'.repeat(23) }),
    { ok: true, ...info, rpc: 'ok', balance_yocto: '3' + '0'.repeat(23), balance_near: '0.3000', low_funds: true });
  assert.equal((await health(info, { balance: async () => '12' + '0'.repeat(24) })).low_funds, false);
  assert.equal((await health(info, { balance: async () => '12' + '0'.repeat(24) })).balance_near, '12.0000');
  assert.deepEqual(await health(info, { balance: async () => { throw new TypeError('fetch failed'); } }),
    { ok: true, ...info, rpc: 'unreachable', balance_yocto: null, balance_near: null, low_funds: null });
  assert.deepEqual(await health(info), { ok: true, ...info });
});
test('real RPC NotEnoughBalance body (reason only in error.data) maps to RELAYER_OUT_OF_FUNDS', async () => {
  const { rpc } = await import('../relayer/near.mjs');
  const { friendlySendError } = await import('../relayer/server.mjs');
  // recorded from rpc.testnet.near.org / fastnear on 2026-11-09: cause.info is empty, the reason is in data
  const body = { jsonrpc: '2.0', id: 1, error: { name: 'HANDLER_ERROR', cause: { info: {}, name: 'INVALID_TRANSACTION' }, code: -32000, message: 'Server error',
    data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: { balance: '1850000000000000000000', cost: '245500818750000000000', signer_id: 'broke.relayer.testnet' } } } } } };
  const err = await rpc('send_tx', {}, { rpcs: ['http://x'], fetchImpl: async () => ({ json: async () => body }) }).catch((e) => e);
  assert.match(err.message, /NotEnoughBalance/);
  assert.equal(friendlySendError(err, 'broke.relayer.testnet').code, 'RELAYER_OUT_OF_FUNDS');
  assert.equal(friendlySendError(err, 'other-relayer.testnet'), null); // someone else's balance: not the relayer's problem
});
