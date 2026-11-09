// ShowUp gasless relayer (NEP-366), testnet only.
//   POST /relay  {"signed_delegate": "<base64 borsh SignedDelegateAction>"}
//     -> 200 {ok, hash, explorer, sender, receiver, methods, gas_burnt}  (relayer paid the gas)
//     -> 403 {ok:false, error}  policy rejection (incl. key not on sender / used nonce), nothing sent
//     -> 503 {ok:false, error, retryable:true}  NEAR RPC unreachable before sending, nothing sent
//     -> 503 {ok:false, error, retryable:false, code:"RELAYER_OUT_OF_FUNDS"}  relayer can't pay, nothing charged
//     -> 502 {ok:false, error, hash?}  sent but failed on-chain / RPC error while sending
//     The same signed action posted again returns the first result (replayed: true); it is never sent twice.
//   GET /health -> {ok, relayer, factory, network, rpc, balance_yocto, balance_near, low_funds}
// Env: RELAYER_ACCOUNT (required, *.testnet, key in ~/.near-credentials/testnet), FACTORY, PORT (3030),
//      NEAR_RPC, VERIFY_FACTORY=0 to skip the factory get_event lookup.
import { createServer } from 'node:http';
import { decodeSignedDelegateBase64, publicKeyToString, actions as A } from '../lib/nep366.mjs';
import { checkDelegate, checkAccessKey, verifyEscrowWithFactory, preflight } from './policy.mjs';
import * as near from './near.mjs';

export const DEFAULT_FACTORY = 'showup-factory-1793597558.testnet';
export const explorerTx = (h) => `https://testnet.near.rocks/txns/${h}`; // nearblocks UI is Cloudflare-blocked
export const LOW_FUNDS_YOCTO = 5n * 10n ** 23n; // 0.5 NEAR
export const RPC_DOWN_ERROR = 'NEAR testnet RPC is unreachable right now; nothing was sent. Try again in a minute.';
const rpcDownResponse = () => [503, { ok: false, error: RPC_DOWN_ERROR, retryable: true }];

/** Network / timeout / rate-limit failure (no answer from NEAR), as opposed to an RPC answer like UNKNOWN_ACCOUNT. */
export function isRpcDown(e) {
  if (e?.unreachable) return true;
  if (e?.rpc) return /TIMEOUT|-429/.test(e.message);
  return /fetch failed|Failed to fetch|NetworkError|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket hang up|aborted|timed? ?out|-429|HTTP 5\d\d|status 5\d\d|Unexpected token|not valid JSON/i.test(String(e?.message ?? e));
}

/** Maps a send error caused by the relayer's own balance to a friendly 503 body; null for anything else. */
export function friendlySendError(e, relayerId) {
  const m = String(e?.message ?? e);
  if (!/NotEnoughBalance|LackBalanceForState|not enough balance|insufficient balance/i.test(m)) return null;
  if (relayerId && !m.includes(relayerId) && /"(signer_id|account_id)"/.test(m)) return null; // someone else's balance
  return { ok: false, error: `The gasless relayer is out of testnet NEAR; nothing was charged to you. Use your wallet instead${relayerId ? ` (or top up ${relayerId})` : ''}.`,
    retryable: false, code: 'RELAYER_OUT_OF_FUNDS' };
}

const fmtNear = (y) => `${y / 10n ** 24n}.${(y % 10n ** 24n).toString().padStart(24, '0').slice(0, 4)}`;
/** GET /health body. Never throws: with the RPC down it reports rpc:"unreachable" and a null balance. */
export async function health(info, chain) {
  if (!chain?.balance) return { ok: true, ...info };
  try {
    const b = BigInt(await chain.balance());
    return { ok: true, ...info, rpc: 'ok', balance_yocto: b.toString(), balance_near: fmtNear(b), low_funds: b < LOW_FUNDS_YOCTO };
  } catch { return { ok: true, ...info, rpc: 'unreachable', balance_yocto: null, balance_near: null, low_funds: null }; }
}

/** Request handler with injectable chain access ({ blockHeight(), nowNs(), view(), accessKey(account, pk), send(sda) }) so it is unit-testable offline. */
export function createRelay({ factory = DEFAULT_FACTORY, relayerId, verifyFactory = true, chain, policy = {}, log = () => {} }) {
  // `${sender}:${pk}:${nonce}` -> promise of the response. A retried/replayed body (same signed action) gets the original
  // result back instead of being paid for or pre-flighted twice. Failed sends are forgotten so the client may retry.
  const seen = new Map();
  // RPC failures before sending: outage -> 503 (retryable, nothing sent), anything else -> 403 with the reason
  const failed = (what) => (e) => ({ ok: false, down: isRpcDown(e), reason: `${what} failed: ${e.message}` });
  const refuse = (r) => { log(r.down ? 'rpc down' : 'reject', r.reason); return r.down ? rpcDownResponse() : [403, { ok: false, error: r.reason }]; };
  return async function relay(body) {
    let sda;
    try { sda = decodeSignedDelegateBase64(body?.signed_delegate); } catch (e) { return [400, { ok: false, error: `bad signed_delegate: ${e.message}` }]; }
    let blockHeight;
    try { blockHeight = await chain.blockHeight(); } catch (e) { log('rpc down', e.message); return rpcDownResponse(); }
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
    const d = sda.delegateAction;
    // the delegate's key must be a live access key of sender_id with an unused nonce, or the runtime rejects it after we paid
    const k = await Promise.resolve().then(() => chain.accessKey(d.senderId, publicKeyToString(d.publicKey)))
      .then((ak) => checkAccessKey(ak, d), failed('access key lookup'));
    if (!k.ok) return refuse(k);
    if (verifyFactory && v.kind === 'escrow') {
      const f = await verifyEscrowWithFactory(v.receiverId, factory, chain.view).catch(failed('factory lookup'));
      if (!f.ok) return refuse(f);
    }
    if (v.kind === 'escrow') {
      const a = sda.delegateAction.actions[0], args = JSON.parse(new TextDecoder().decode(a.args));
      const guest = a.methodName === 'check_in' ? args.guest : v.senderId;
      const pf = await Promise.all([chain.view(v.receiverId, 'get_info', {}), chain.view(v.receiverId, 'get_status', { account_id: guest })])
        .then(([info, status]) => preflight({ method: a.methodName, sender: v.senderId, args, info, status, nowNs: chain.nowNs() }))
        .catch(failed('pre-flight'));
      if (!pf.ok) return refuse(pf);
    }
    try {
      const t0 = Date.now(), { hash, failures, res } = await chain.send(sda);
      log('sent', hash, v.senderId, v.receiverId, v.methods.join(','), failures.length ? 'FAILED' : 'ok', `${Date.now() - t0} ms`);
      const out = { hash, explorer: explorerTx(hash), sender: v.senderId, receiver: v.receiverId, methods: v.methods,
        gas_burnt: res ? near.gasBurnt(res).toString() : undefined, tokens_burnt_yocto: res ? near.tokensBurnt(res).toString() : undefined };
      if (failures.length) return [502, { ok: false, ...out, error: `on-chain failure: ${JSON.stringify(failures[0].failure).slice(0, 300)}` }];
      return [200, { ok: true, ...out }];
    } catch (e) {
      log('send error', e.message);
      const broke = friendlySendError(e, relayerId);
      return broke ? [503, broke] : [502, { ok: false, error: e.message }];
    }
  }
}

export function liveChain(signer) {
  return {
    blockHeight: async () => BigInt((await near.finalBlock()).header.height),
    nowNs: () => BigInt(Date.now()) * 1_000_000n,
    view: (a, m, args) => near.view(a, m, args),
    accessKey: (accountId, publicKey) => near.accessKey(accountId, publicKey),
    balance: async () => (await near.viewAccount(signer.accountId)).amount,
    send: (sda) => near.sendTx(signer, sda.delegateAction.senderId, [A.delegate(sda)]),
  };
}

export function serve({ port = 3030, relay, info, chain }) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const send = (res, status, obj) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const srv = createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method === 'GET' && p === '/health') return send(res, 200, await health(info, chain));
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
  const signer = near.loadKey(relayerId), chain = liveChain(signer);
  const relay = createRelay({ factory, relayerId, verifyFactory: process.env.VERIFY_FACTORY !== '0', chain,
    log: (...a) => console.log(new Date().toISOString(), ...a) });
  const port = Number(process.env.PORT || 3030);
  serve({ port, relay, chain, info: { relayer: relayerId, factory, network: 'testnet' } })
    .on('listening', () => console.log(`ShowUp relayer on http://localhost:${port} (relayer ${relayerId}, factory ${factory}, testnet)`));
}
