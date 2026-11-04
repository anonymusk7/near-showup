// ShowUp gasless relayer (NEP-366), testnet only.
//   POST /relay  {"signed_delegate": "<base64 borsh SignedDelegateAction>"}
//     -> 200 {ok, hash, explorer, sender, receiver, methods, gas_burnt}  (relayer paid the gas)
//     -> 403 {ok:false, error}  policy rejection, nothing sent
//     -> 502 {ok:false, error, hash?}  sent but failed on-chain / RPC error
//     The same signed action posted again returns the first result (replayed: true); it is never sent twice.
//   GET /health -> {ok, relayer, factory, network}
// Env: RELAYER_ACCOUNT (required, *.testnet, key in ~/.near-credentials/testnet), FACTORY, PORT (3030),
//      NEAR_RPC, VERIFY_FACTORY=0 to skip the factory get_event lookup.
import { createServer } from 'node:http';
import { decodeSignedDelegateBase64, actions as A } from '../lib/nep366.mjs';
import { checkDelegate, verifyEscrowWithFactory, preflight } from './policy.mjs';
import * as near from './near.mjs';

export const DEFAULT_FACTORY = 'showup-factory-1793597558.testnet';
export const explorerTx = (h) => `https://testnet.nearblocks.io/txns/${h}`;

/** Request handler with injectable chain access ({ blockHeight(), nowNs(), view(), send(sda) }) so it is unit-testable offline. */
export function createRelay({ factory = DEFAULT_FACTORY, relayerId, verifyFactory = true, chain, policy = {}, log = () => {} }) {
  // `${sender}:${pk}:${nonce}` -> promise of the response. A retried/replayed body (same signed action) gets the original
  // result back instead of being paid for or pre-flighted twice. Failed sends are forgotten so the client may retry.
  const seen = new Map();
  return async function relay(body) {
    let sda;
    try { sda = decodeSignedDelegateBase64(body?.signed_delegate); } catch (e) { return [400, { ok: false, error: `bad signed_delegate: ${e.message}` }]; }
    const blockHeight = await chain.blockHeight();
    const v = checkDelegate(sda, { ...policy, factory, relayerId, blockHeight });
    if (!v.ok) { log('reject', v.reason); return [403, { ok: false, error: v.reason }]; }
    const d = sda.delegateAction, key = `${d.senderId}:${Buffer.from(d.publicKey.data).toString('hex')}:${d.nonce}`;
    if (seen.has(key)) { const [st, obj] = await seen.get(key); log('replay', key); return [st, { ...obj, replayed: true }]; }
    const p = execute(sda, v);
    seen.set(key, p);
    if (seen.size > 10_000) seen.delete(seen.keys().next().value);
    const [st, obj] = await p;
    if (st !== 200) seen.delete(key);
    return [st, obj];
  };
  async function execute(sda, v) {
    if (verifyFactory && v.kind === 'escrow') {
      const f = await verifyEscrowWithFactory(v.receiverId, factory, chain.view).catch((e) => ({ ok: false, reason: `factory lookup failed: ${e.message}` }));
      if (!f.ok) { log('reject', f.reason); return [403, { ok: false, error: f.reason }]; }
    }
    if (v.kind === 'escrow') {
      const a = sda.delegateAction.actions[0], args = JSON.parse(new TextDecoder().decode(a.args));
      const guest = a.methodName === 'check_in' ? args.guest : v.senderId;
      const pf = await Promise.all([chain.view(v.receiverId, 'get_info', {}), chain.view(v.receiverId, 'get_status', { account_id: guest })])
        .then(([info, status]) => preflight({ method: a.methodName, sender: v.senderId, args, info, status, nowNs: chain.nowNs() }))
        .catch((e) => ({ ok: false, reason: `pre-flight failed: ${e.message}` }));
      if (!pf.ok) { log('reject', pf.reason); return [403, { ok: false, error: pf.reason }]; }
    }
    try {
      const t0 = Date.now(), { hash, failures, res } = await chain.send(sda);
      log('sent', hash, v.senderId, v.receiverId, v.methods.join(','), failures.length ? 'FAILED' : 'ok', `${Date.now() - t0} ms`);
      const out = { hash, explorer: explorerTx(hash), sender: v.senderId, receiver: v.receiverId, methods: v.methods,
        gas_burnt: res ? near.gasBurnt(res).toString() : undefined, tokens_burnt_yocto: res ? near.tokensBurnt(res).toString() : undefined };
      if (failures.length) return [502, { ok: false, ...out, error: `on-chain failure: ${JSON.stringify(failures[0].failure).slice(0, 300)}` }];
      return [200, { ok: true, ...out }];
    } catch (e) { log('send error', e.message); return [502, { ok: false, error: e.message }]; }
  }
}

export function liveChain(signer) {
  return {
    blockHeight: async () => BigInt((await near.finalBlock()).header.height),
    nowNs: () => BigInt(Date.now()) * 1_000_000n,
    view: (a, m, args) => near.view(a, m, args),
    send: (sda) => near.sendTx(signer, sda.delegateAction.senderId, [A.delegate(sda)]),
  };
}

export function serve({ port = 3030, relay, info }) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const send = (res, status, obj) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const srv = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, ...info });
    if (req.method !== 'POST' || p !== '/relay') return send(res, 404, { ok: false, error: 'not found' });
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 8192) return send(res, 413, { ok: false, error: 'too large' }); chunks.push(c); }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return send(res, 400, { ok: false, error: 'bad json' }); }
    try { const [status, obj] = await relay(body); send(res, status, obj); } catch (e) { send(res, 500, { ok: false, error: e.message }); }
  });
  srv.keepAliveTimeout = 120_000; srv.requestTimeout = 180_000; // send_tx can take a while; don't drop the client mid-relay
  return srv.listen(port);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const relayerId = process.env.RELAYER_ACCOUNT, factory = process.env.FACTORY || DEFAULT_FACTORY;
  if (!relayerId) { console.error('set RELAYER_ACCOUNT=<relayer>.testnet (key in ~/.near-credentials/testnet)'); process.exit(2); }
  near.assertTestnet(relayerId); near.assertTestnet(factory);
  const signer = near.loadKey(relayerId);
  const relay = createRelay({ factory, relayerId, verifyFactory: process.env.VERIFY_FACTORY !== '0', chain: liveChain(signer),
    log: (...a) => console.log(new Date().toISOString(), ...a) });
  const port = Number(process.env.PORT || 3030);
  serve({ port, relay, info: { relayer: relayerId, factory, network: 'testnet' } })
    .on('listening', () => console.log(`ShowUp relayer on http://localhost:${port} (relayer ${relayerId}, factory ${factory}, testnet)`));
}
