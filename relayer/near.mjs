// Node-side NEAR testnet helpers for the relayer and its demo: JSON-RPC, legacy keychain keys, signed tx submit.
// Testnet only: refuses mainnet RPCs and non-.testnet accounts.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { signTransaction, toBase64, parseSecretKey } from '../lib/nep366.mjs';

export const RPCS = (process.env.NEAR_RPC ? [process.env.NEAR_RPC] : ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org']);
export function assertTestnet(accountId, rpcs = RPCS) {
  if (!/\.testnet$/.test(accountId)) throw new Error(`refusing non-testnet account ${accountId}`);
  for (const r of rpcs) if (/mainnet|rpc\.near\.org|rpc\.fastnear\.com/.test(r) && !/testnet/.test(r)) throw new Error(`refusing non-testnet RPC ${r}`);
}

export async function rpc(method, params, { rpcs = RPCS, fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  let last;
  for (const url of rpcs) {
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: '2.0', id: 'showup-relayer', method, params }) });
      const j = await r.json();
      if (j.error) {
        const e = new Error(`RPC ${method}: ${JSON.stringify(j.error.cause ?? j.error.data ?? j.error).slice(0, 400)}`); e.rpc = j.error;
        if (j.error.code === -429 || /TIMEOUT|-429/.test(e.message)) { last = e; continue; }
        throw e;
      }
      if (j.result?.error) { const e = new Error(`RPC ${method}: ${j.result.error}`); e.rpc = j.result.error; throw e; } // an answer, not an outage
      return j.result;
    } catch (e) { if (e.rpc && !/TIMEOUT|-429/.test(e.message)) throw e; last = e; }
  }
  last.unreachable = true; // every RPC failed at the network / rate-limit level
  throw last;
}
export const view = async (account_id, method_name, args = {}, o) => {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id, method_name, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') }, o);
  return JSON.parse(Buffer.from(r.result).toString() || 'null');
};
export const viewAccount = (account_id, o) => rpc('query', { request_type: 'view_account', finality: 'final', account_id }, o);
export const finalBlock = (o) => rpc('block', { finality: 'final' }, o);
/** view_access_key, or null when the key (or the account) doesn't exist. Other errors (RPC down) throw. */
export async function accessKey(account_id, public_key, o) {
  try { return await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id, public_key }, o); }
  catch (e) { if (e.rpc && /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(e.message)) return null; throw e; }
}

/** Reads ~/.near-credentials/testnet/<account>.json (near-cli legacy keychain). The secret never leaves this process. */
export function loadKey(accountId, dir = path.join(os.homedir(), '.near-credentials', 'testnet')) {
  assertTestnet(accountId);
  const cred = JSON.parse(fs.readFileSync(path.join(dir, `${accountId}.json`), 'utf8'));
  const secretKey = cred.private_key || cred.secret_key;
  const { publicKey } = parseSecretKey(secretKey);
  if (cred.public_key && cred.public_key !== publicKey) throw new Error(`key file for ${accountId} is inconsistent`);
  return { accountId, publicKey, secretKey };
}

/** Collects Failure statuses from the tx outcome and all receipts (a Delegate can succeed while its inner call fails). */
export function outcomeFailures(res) {
  const out = [];
  for (const o of [res.transaction_outcome, ...(res.receipts_outcome || [])]) {
    const f = o?.outcome?.status?.Failure;
    if (f) out.push({ id: o.id, executor: o.outcome.executor_id, failure: f });
  }
  return out;
}
export const gasBurnt = (res) => [res.transaction_outcome, ...(res.receipts_outcome || [])].reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
export const tokensBurnt = (res) => [res.transaction_outcome, ...(res.receipts_outcome || [])].reduce((s, o) => s + BigInt(o.outcome.tokens_burnt), 0n);

/** Signs `actions` as `signer` to `receiverId` and waits for execution. Serialized per signer so nonces never clash. */
const queues = new Map();
export function sendTx(signer, receiverId, actions, o = {}) {
  const prev = queues.get(signer.accountId) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    assertTestnet(signer.accountId, o.rpcs);
    const ak = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: signer.accountId, public_key: signer.publicKey }, o);
    const blk = await finalBlock(o);
    const nonce = BigInt(ak.nonce) + 1n;
    const { bytes, hash } = signTransaction({ signerId: signer.accountId, publicKey: signer.publicKey, nonce, receiverId, blockHash: blk.header.hash, actions }, signer.secretKey);
    const res = await rpc('send_tx', { signed_tx_base64: toBase64(bytes), wait_until: 'EXECUTED_OPTIMISTIC' }, o); // resubmitting the same signed tx elsewhere is idempotent
    return { hash, res, failures: outcomeFailures(res) };
  });
  queues.set(signer.accountId, run);
  return run;
}
