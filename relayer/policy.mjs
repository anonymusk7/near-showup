// Relayer policy (pure): which SignedDelegateActions the ShowUp relayer will pay gas for.
// Accept only zero-deposit FunctionCalls to allow-listed methods on the factory or on a
// `<name>.<factory>` escrow, with bounded gas and a short max_block_height. Everything else is rejected.
import { verifySignedDelegate, publicKeyToString } from '../lib/nep366.mjs';

export const TGAS = 10n ** 12n;
export const DEFAULTS = Object.freeze({
  escrowMethods: ['check_in', 'cancel'],
  factoryMethods: [], // the factory has no zero-deposit public change method worth sponsoring (create_event is payable)
  maxGasPerAction: 50n * TGAS,
  maxTotalGas: 100n * TGAS,
  maxActions: 1,
  maxTtlBlocks: 1200n, // ≈ 20 min on testnet
  maxArgsBytes: 512,
});
const ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const LABEL_RE = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/; // factory valid_name(): 2..=32 chars, alnum at both ends
export const isAccountId = (s) => typeof s === 'string' && ACCOUNT_RE.test(s);

/** 'factory' | 'escrow' | null. An escrow is exactly one valid label in front of the factory account. */
export function receiverKind(receiverId, factory) {
  if (receiverId === factory) return 'factory';
  const suffix = '.' + factory;
  if (!receiverId.endsWith(suffix)) return null;
  const label = receiverId.slice(0, -suffix.length);
  return LABEL_RE.test(label) ? 'escrow' : null;
}

const td = new TextDecoder('utf-8', { fatal: true });
function checkArgs(method, bytes, max) {
  if (bytes.length > max) return `args larger than ${max} bytes`;
  let a; try { a = JSON.parse(td.decode(bytes)); } catch { return 'args are not JSON'; }
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return 'args must be a JSON object';
  const keys = Object.keys(a);
  if (method === 'cancel' && keys.length) return 'cancel takes no args';
  if (method === 'check_in' && (keys.length !== 1 || !isAccountId(a.guest))) return 'check_in args must be {"guest": "<account>"}';
  return null;
}

/**
 * @param sda  decoded SignedDelegateAction (lib/nep366.mjs)
 * @param ctx  { factory, blockHeight (current final height, bigint), relayerId?, ...DEFAULTS overrides }
 * @returns { ok: true, kind, receiverId, senderId, methods, totalGas } | { ok: false, reason }
 */
export function checkDelegate(sda, ctx) {
  const c = { ...DEFAULTS, ...ctx };
  const no = (reason) => ({ ok: false, reason });
  const d = sda?.delegateAction;
  if (!d || !sda.signature) return no('not a SignedDelegateAction');
  if (!isAccountId(c.factory)) return no('relayer misconfigured: factory');
  if (!/\.testnet$/.test(c.factory)) return no('testnet only');
  if (!isAccountId(d.senderId)) return no('invalid sender_id');
  if (!isAccountId(d.receiverId)) return no('invalid receiver_id');
  if (c.relayerId && d.senderId === c.relayerId) return no('sender must not be the relayer');
  const kind = receiverKind(d.receiverId, c.factory);
  if (!kind) return no(`receiver ${d.receiverId} is not the factory or a <name>.${c.factory} escrow`);
  const allowed = kind === 'escrow' ? c.escrowMethods : c.factoryMethods;
  if (!d.actions.length) return no('no actions');
  if (d.actions.length > c.maxActions) return no(`at most ${c.maxActions} action(s)`);
  let totalGas = 0n;
  const methods = [];
  for (const a of d.actions) {
    if (a.type !== 'FunctionCall') return no(`action ${a.type} is not allowed (FunctionCall only)`);
    if (!allowed.includes(a.methodName)) return no(`method ${a.methodName} is not allowed on ${kind} (allowed: ${allowed.join(', ') || 'none'})`);
    if (a.deposit !== 0n) return no('attached deposit must be 0');
    if (a.gas <= 0n || a.gas > c.maxGasPerAction) return no(`gas must be in 1..${c.maxGasPerAction / TGAS} Tgas`);
    const argErr = checkArgs(a.methodName, a.args, c.maxArgsBytes);
    if (argErr) return no(argErr);
    totalGas += a.gas; methods.push(a.methodName);
  }
  if (totalGas > c.maxTotalGas) return no(`total gas above ${c.maxTotalGas / TGAS} Tgas`);
  if (c.blockHeight == null) return no('relayer has no block height');
  const h = BigInt(c.blockHeight);
  if (d.maxBlockHeight <= h) return no('delegate action expired (max_block_height passed)');
  if (d.maxBlockHeight > h + c.maxTtlBlocks) return no(`max_block_height more than ${c.maxTtlBlocks} blocks ahead`);
  if (d.nonce <= 0n) return no('nonce must be > 0');
  if (d.publicKey.keyType !== 0) return no('ed25519 keys only');
  if (!verifySignedDelegate(sda)) return no(`signature does not verify for ${publicKeyToString(d.publicKey)}`);
  return { ok: true, kind, receiverId: d.receiverId, senderId: d.senderId, methods, totalGas };
}

/** Optional on-chain check: the escrow is a record of the factory (factory.get_event(name)). `view` is (account, method, args) => value. */
export async function verifyEscrowWithFactory(receiverId, factory, view) {
  if (receiverId === factory) return { ok: true };
  const name = receiverId.slice(0, -(factory.length + 1));
  const rec = await view(factory, 'get_event', { name });
  if (!rec || rec.account_id !== receiverId) return { ok: false, reason: `${receiverId} is not an event created by ${factory}` };
  return { ok: true, host: rec.host };
}

/**
 * Anti-griefing pre-flight (pure): mirror the escrow's own requires so the relayer doesn't pay for calls that will panic.
 * `info` = escrow get_info, `status` = get_status of the affected guest (sender for cancel, args.guest for check_in).
 */
export function preflight({ method, sender, args, info, status, nowNs }) {
  const now = BigInt(nowNs);
  if (info.settled) return { ok: false, reason: 'event already settled' };
  if (method === 'cancel') {
    if (now >= BigInt(info.cancel_deadline_ns)) return { ok: false, reason: 'cancellation deadline passed' };
    if (status !== 'Rsvp') return { ok: false, reason: `${sender} has no active RSVP` };
    return { ok: true };
  }
  if (method === 'check_in') {
    if (sender !== info.host && !(info.checkers || []).includes(sender)) return { ok: false, reason: `${sender} is not the host or a checker` };
    if (now < BigInt(info.checkin_start_ns) || now > BigInt(info.checkin_end_ns)) return { ok: false, reason: 'outside check-in window' };
    if (status !== 'Rsvp') return { ok: false, reason: `${args.guest} has no active RSVP` };
    return { ok: true };
  }
  return { ok: false, reason: `no pre-flight for ${method}` };
}
