// ShowUp widget core: pure helpers + fetch-injectable RPC/1Click calls. Runs in browsers and Node (tests).
export const RPC_TESTNET = 'https://rpc.testnet.near.org';
export const ONECLICK_BASE = 'https://1click.chaindefuser.com/v0';
export const YOCTO = 10n ** 24n;
// 1Click runs on mainnet only, so the preview prices the deposit as wNEAR on mainnet.
export const WNEAR = 'nep141:wrap.near';
export const PREVIEW_RECIPIENT = 'anonymusk.near';
export const ORIGINS = [
  { id: 'usdc-base', label: 'USDC on Base', symbol: 'USDC', asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', refundTo: '0x0000000000000000000000000000000000000001' },
  { id: 'usdc-arb', label: 'USDC on Arbitrum', symbol: 'USDC', asset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', refundTo: '0x0000000000000000000000000000000000000001' },
  { id: 'usdc-sol', label: 'USDC on Solana', symbol: 'USDC', asset: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', refundTo: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
  { id: 'eth-base', label: 'ETH on Base', symbol: 'ETH', asset: 'nep141:base.omft.near', refundTo: '0x0000000000000000000000000000000000000001' },
  { id: 'sol', label: 'SOL on Solana', symbol: 'SOL', asset: 'nep141:sol.omft.near', refundTo: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
];

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export function buildViewRequest(accountId, method, args = {}) {
  return { jsonrpc: '2.0', id: 'showup', method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: accountId, method_name: method, args_base64: b64(JSON.stringify(args)) } };
}

export function parseViewResponse(json) {
  if (json.error) throw new Error(`RPC error: ${json.error.cause?.name || json.error.name || 'unknown'} ${json.error.data || json.error.message || ''}`.trim());
  if (json.result?.error) throw new Error(`view failed: ${json.result.error}`);
  if (!Array.isArray(json.result?.result)) throw new Error('malformed RPC response');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json.result.result)));
}

// rpc.testnet.near.org sometimes answers -429 (rate limit / deprecation notice); fall back to FastNEAR's public testnet RPC.
export const RPC_FALLBACKS = [RPC_TESTNET, 'https://rpc.testnet.fastnear.com'];

/** View call. An explicit `rpc` is used alone; otherwise each RPC_FALLBACKS entry is tried on network error, HTTP error or -429. */
export async function viewCall(accountId, method, args = {}, { rpc, fetchImpl = fetch } = {}) {
  const body = JSON.stringify(buildViewRequest(accountId, method, args));
  let lastErr;
  for (const url of rpc ? [rpc] : RPC_FALLBACKS) {
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
      const json = await r.json();
      if (json.error?.code === -429) throw new Error(`RPC -429 ${json.error.message || ''}`.trim());
      return parseViewResponse(json);
    } catch (e) {
      if (/^(RPC error|view failed|malformed)/.test(e.message)) throw e; // contract-level answer: don't retry elsewhere
      lastErr = e;
    }
  }
  throw lastErr;
}

/** yocto string/bigint -> "1.2345" (truncated, trailing zeros trimmed). */
export function formatNear(yocto, digits = 4) {
  const y = BigInt(yocto), whole = y / YOCTO, frac = (y % YOCTO).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function phaseOf(info, nowNs) {
  const now = BigInt(nowNs);
  if (info.settled) return 'settled';
  if (now < BigInt(info.cancel_deadline_ns)) return 'open';
  if (now < BigInt(info.checkin_start_ns)) return 'closed';
  if (now <= BigInt(info.checkin_end_ns)) return 'checkin';
  return 'ended';
}

export const PHASE_LABEL = { open: 'RSVP open', closed: 'RSVP closed', checkin: 'Check-in live', ended: 'Ended, awaiting settle', settled: 'Settled' };

export function eventSummary(info, nowNs) {
  const spotsLeft = Math.max(0, info.capacity - info.active), phase = phaseOf(info, nowNs);
  return { host: info.host, deposit: String(info.deposit), depositNear: formatNear(info.deposit), capacity: info.capacity,
    active: info.active, spotsLeft, phase, phaseLabel: PHASE_LABEL[phase], canRsvp: phase === 'open' && spotsLeft > 0,
    cancelDeadline: new Date(Number(BigInt(info.cancel_deadline_ns) / 1_000_000n)).toISOString() };
}

export function buildQuoteRequest({ originAsset, depositYocto, refundTo, recipient = PREVIEW_RECIPIENT, now = Date.now() }) {
  if (!originAsset || !depositYocto || !refundTo) throw new Error('missing quote fields');
  return { dry: true, swapType: 'EXACT_OUTPUT', slippageTolerance: 100, originAsset, depositType: 'ORIGIN_CHAIN',
    destinationAsset: WNEAR, amount: String(depositYocto), refundTo, refundType: 'ORIGIN_CHAIN', recipient,
    recipientType: 'DESTINATION_CHAIN', deadline: new Date(now + 3600e3).toISOString() };
}

/** Dry (no funds, no deposit address) 1Click quote: how much of `origin` buys exactly the deposit in NEAR. */
export async function quoteDeposit(origin, depositYocto, { base = ONECLICK_BASE, fetchImpl = fetch, now } = {}) {
  const body = buildQuoteRequest({ originAsset: origin.asset, depositYocto, refundTo: origin.refundTo, now });
  const r = await fetchImpl(`${base}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`1Click quote failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export function summarizeQuote(q, origin) {
  const x = q?.quote;
  if (!x?.amountInFormatted) throw new Error('quote missing amountIn');
  return { pay: `${x.amountInFormatted} ${origin.symbol}`, from: origin.label, usd: x.amountInUsd ? Number(x.amountInUsd).toFixed(2) : null,
    receive: `${x.amountOutFormatted} NEAR`, etaSec: x.timeEstimate ?? null };
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function rsvpCommand(eventId, depositYocto) {
  return `near contract call-function as-transaction ${eventId} rsvp json-args '{}' prepaid-gas '30.0 Tgas' attached-deposit '${formatNear(depositYocto, 24)} NEAR' sign-as <your-account>.testnet network-config testnet sign-with-keychain send`;
}

export function renderCard(eventId, s) {
  const e = escapeHtml;
  const opts = ORIGINS.map((o) => `<option value="${o.id}">${e(o.label)}</option>`).join('');
  return `<div class="card">
  <div class="head"><strong>${e(eventId)}</strong><span class="pill ${s.phase}">${e(s.phaseLabel)}</span></div>
  <dl>
    <div><dt>Deposit</dt><dd data-k="deposit">${e(s.depositNear)} NEAR</dd></div>
    <div><dt>Capacity</dt><dd data-k="capacity">${s.capacity}</dd></div>
    <div><dt>Spots left</dt><dd data-k="spots">${s.spotsLeft}</dd></div>
  </dl>
  <p class="fine">Show up and get your deposit back plus a share of the no-shows' deposits. ${s.phase === 'open' ? `You can cancel for a full refund until ${e(s.cancelDeadline.replace('T', ' ').slice(0, 16))} UTC.` : 'RSVPs are closed.'}</p>
  <button class="rsvp" ${s.canRsvp ? '' : 'disabled'}>${s.canRsvp ? `RSVP: lock ${e(s.depositNear)} NEAR` : e(s.phaseLabel)}</button>
  <pre class="cmd" hidden></pre>
  ${s.canRsvp ? `<div class="pay"><label>Pay from any chain (1Click preview) <select name="origin">${opts}</select></label><div class="quote">…</div></div>` : ''}
</div>`;
}

export const CSS = `:host{all:initial;font:14px/1.4 system-ui,sans-serif;color:#111}
.card{border:1px solid #ddd;border-radius:12px;padding:16px;max-width:380px;background:#fff}
.head{display:flex;justify-content:space-between;align-items:center;gap:8px;word-break:break-all}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;background:#eee;white-space:nowrap}.pill.open{background:#d9f7e3}.pill.settled{background:#e3e8ff}
dl{display:flex;gap:16px;margin:12px 0}dt{font-size:12px;color:#666}dd{margin:0;font-weight:600}
.fine{font-size:12px;color:#555}button{width:100%;padding:10px;border:0;border-radius:8px;background:#111;color:#fff;font-weight:600;cursor:pointer}
button[disabled]{background:#999;cursor:default}.cmd{white-space:pre-wrap;word-break:break-all;font-size:11px;background:#f6f6f6;padding:8px;border-radius:6px}
.pay{margin-top:12px;font-size:13px}.quote{margin-top:6px;color:#333}.err{color:#b00}`;

/** DOM glue: renders into a shadow root and wires the RSVP button + quote selector. */
export async function mountWidget(host, eventId, { rpc, fetchImpl = fetch } = {}) {
  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  root.innerHTML = `<style>${CSS}</style><div class="card">Loading ${escapeHtml(eventId)}…</div>`;
  let info;
  try { info = await viewCall(eventId, 'get_info', {}, { rpc, fetchImpl }); }
  catch (err) { root.innerHTML = `<style>${CSS}</style><div class="card err">ShowUp: ${escapeHtml(err.message)}</div>`; return; }
  const s = eventSummary(info, BigInt(Date.now()) * 1_000_000n);
  root.innerHTML = `<style>${CSS}</style>${renderCard(eventId, s)}`;
  const cmd = root.querySelector('.cmd');
  root.querySelector('.rsvp').addEventListener('click', () => { cmd.textContent = `RSVP from a terminal (wallet selector coming next):\n${rsvpCommand(eventId, s.deposit)}`; cmd.hidden = false; });
  const sel = root.querySelector('select'), out = root.querySelector('.quote');
  if (!sel) return s;
  const refresh = async () => {
    const origin = ORIGINS.find((o) => o.id === sel.value);
    out.textContent = 'Fetching live dry quote…';
    try {
      const q = summarizeQuote(await quoteDeposit(origin, s.deposit, { fetchImpl }), origin);
      out.innerHTML = `Pay <b>${escapeHtml(q.pay)}</b>${q.usd ? ` (≈ $${q.usd})` : ''} → ${escapeHtml(q.receive)} in ~${q.etaSec ?? '?'}s. <span class="fine">Dry quote, no funds moved. 1Click is mainnet only, so this prices the deposit as mainnet wNEAR.</span>`;
    } catch (err) { out.innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`; }
  };
  sel.addEventListener('change', refresh);
  refresh();
  return s;
}
