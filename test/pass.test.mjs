// Signed rotating check-in passes (widget/pass.mjs): a screenshot can't be reused at the door.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as P from '../widget/pass.mjs';
import { ed25519, b58encode, b58decode } from '../widget/vendor/crypto.js';

const fix = JSON.parse(readFileSync(new URL('./fixtures/nep413-nearjs.json', import.meta.url), 'utf8'));
const EV = 'ethdenver-side.showup-factory-1793597558.testnet', G = 'alice.testnet';
const T0 = Date.parse('2026-11-02T10:00:00Z');

// A stand-in "wallet": signs NEP-413 exactly like near-js (cross-checked below).
const walletSk = new Uint8Array(32).fill(9), walletPk = 'ed25519:' + b58encode(ed25519.getPublicKey(walletSk));
const wallet = (req, callbackUrl = null) => ({ accountId: G, publicKey: walletPk,
  signature: Buffer.from(ed25519.sign(P.nep413Hash({ ...req.request, callbackUrl }), walletSk)).toString('base64') });
const chain = (keys) => async (acct, pk) => keys[`${acct}|${pk}`] ?? null;
const onChain = chain({ [`${G}|${walletPk}`]: 'FullAccess' });
let n = 0; const rnd = (k) => new Uint8Array(k).fill(++n);
const mk = (cb = null) => { const req = P.newPassRequest({ event: EV, guest: G, nowMs: T0, random: rnd }); return P.makeCert(req, { event: EV, guest: G }, wallet(req, cb), cb); };

test('NEP-413 hash matches near-js KeyPairSigner.signNep413Message (with and without callbackUrl)', () => {
  for (const c of fix.cases) {
    const h = P.nep413Hash({ message: c.message, recipient: c.recipient, nonce: Buffer.from(c.nonce, 'base64'), callbackUrl: c.callbackUrl });
    assert.ok(ed25519.verify(Buffer.from(c.signature, 'base64'), h, b58decode(c.publicKey.slice(8))), c.callbackUrl ?? 'no cb');
  }
});
test('live frame verifies; the guest wallet key must be a full-access key on-chain', async () => {
  const f = P.passFrame(mk(), T0 + 2000);
  const r = await P.verifyPass(f, { event: EV, nowMs: T0 + 4000, accessKey: onChain, seen: new Set() });
  assert.deepEqual([r.ok, r.guest, r.ageMs], [true, G, 2000]);
  const fc = await P.verifyPass(f, { event: EV, nowMs: T0 + 4000, accessKey: chain({ [`${G}|${walletPk}`]: { FunctionCall: {} } }), seen: new Set() });
  assert.match(fc.reason, /function-call key/);
  const none = await P.verifyPass(f, { event: EV, nowMs: T0 + 4000, accessKey: chain({}), seen: new Set() });
  assert.match(none.reason, /not a key of alice.testnet/);
});
test('a screenshot is rejected: stale after 30 s, and the same frame scans only once', async () => {
  const cert = mk(), f = P.passFrame(cert, T0), seen = new Set();
  assert.match((await P.verifyPass(f, { event: EV, nowMs: T0 + 31_000, accessKey: onChain, seen })).reason, /31 s old: likely a screenshot/);
  assert.equal((await P.verifyPass(f, { event: EV, nowMs: T0 + 1000, accessKey: onChain, seen })).ok, true);
  assert.match((await P.verifyPass(f, { event: EV, nowMs: T0 + 2000, accessKey: onChain, seen })).reason, /already scanned/);
  assert.equal((await P.verifyPass(P.passFrame(cert, T0 + 10_000), { event: EV, nowMs: T0 + 11_000, accessKey: onChain, seen })).ok, true, 'next rotation is fine');
});
test('forgeries fail: other guest, other event, edited timestamp, swapped ephemeral key, expired cert', async () => {
  const cert = mk(), f = P.passFrame(cert, T0), opts = { event: EV, nowMs: T0 + 1000, accessKey: onChain, seen: new Set() };
  assert.match((await P.verifyPass(f.replace(`g=${G}`, 'g=mallory.testnet'), opts)).reason, /wallet signature/);
  assert.match((await P.verifyPass(f, { ...opts, event: 'other.testnet' })).reason, /not this event/);
  assert.match((await P.verifyPass(f.replace(`t=${T0}`, `t=${T0 + 20_000}`), { ...opts, nowMs: T0 + 21_000 })).reason, /rotating code signature/);
  const mal = P.newPassRequest({ event: EV, guest: G, nowMs: T0, random: rnd });
  const forged = P.passFrame({ ...cert, ephPk: mal.ephPk, ephSk: mal.ephSk }, T0);
  assert.match((await P.verifyPass(forged, opts)).reason, /wallet signature/, 'attacker key is not in the wallet-signed cert');
  assert.match((await P.verifyPass(f, { ...opts, nowMs: T0 + P.CERT_TTL_MS + 1 })).reason, /expired/);
  assert.match((await P.verifyPass('showup:checkin?event=a.testnet&guest=b.testnet', opts)).reason, /not a signed/);
});
test('redirect wallets: callbackUrl inside or outside the signed payload both verify', async () => {
  const cb = 'http://localhost:8787/widget/demo.html';
  for (const signedWith of [cb, null]) {
    const req = P.newPassRequest({ event: EV, guest: G, nowMs: T0, random: rnd });
    const cert = P.makeCert(req, { event: EV, guest: G }, wallet(req, signedWith), cb);
    assert.equal((await P.verifyPass(P.passFrame(cert, T0), { event: EV, nowMs: T0, accessKey: onChain, seen: new Set() })).ok, true);
  }
  assert.throws(() => P.makeCert(P.newPassRequest({ event: EV, guest: G }), { event: EV, guest: 'bob.testnet' }, { accountId: G, publicKey: walletPk, signature: 'AA' }), /expected bob/);
});
test('pass fits in a scannable QR', () => { assert.ok(P.passFrame(mk('http://localhost:8787/widget/demo.html?event=' + EV)).length < 900); });
