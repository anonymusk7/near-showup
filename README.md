# ShowUp: event deposits where no-shows pay the people who show up

```yaml
project: ShowUp
tracks: [realworld, open]
one_liner: RSVP deposits for events, escrowed by a NEAR contract; no-shows' deposits are split among attendees.
near: [rust near-sdk 5.5 escrow + factory contracts (sub-accounts, batched receipts, callbacks), testnet JSON-RPC from the browser, NEAR Intents 1Click dry quotes]
network: testnet (1Click quotes: mainnet, dry:true only)
try_it: pnpm test && pnpm serve   # then http://localhost:8080/widget/demo.html
hosted_demo: https://anonymusk7.github.io/showup-demo/widget/demo.html   # testnet, no install
needs_key: false
status: work in progress (NEAR HACKATHON, Nov 2026)
```

Tracks: `realworld` (merchant/event payments with any-chain deposits via NEAR Intents), `open`.

**What:** NEAR contracts plus an embeddable widget and a host dashboard for event RSVPs. Guests lock a deposit to RSVP and get a full refund if they cancel before the deadline. After the event, every attendee gets their deposit back plus an equal share of the no-show deposits.
**Problem:** free crypto side events see about 50% no-shows, and deposits fail because guests don't hold the right token on the right chain. ShowUp previews paying from any chain through NEAR Intents 1Click.

Status: work in progress (NEAR HACKATHON, Nov 2026).

## Hosted demo (no install, NEAR testnet)
- **Widget:** https://anonymusk7.github.io/showup-demo/widget/demo.html
- **Host dashboard:** https://anonymusk7.github.io/showup-demo/dashboard/
- **Door check-in:** https://anonymusk7.github.io/showup-demo/dashboard/checkin.html

It's a static GitHub Pages build of `widget/`, `dashboard/` and two browser libs (`node scripts/build-pages.mjs <out> <commit>`), published from the public repo https://github.com/anonymusk7/showup-demo. It stays up through judging (at least 18 Nov 2026).
- View calls go straight to testnet RPC.
- 1Click dry quotes are called directly. 1Click answers CORS (`access-control-allow-origin: *`, checked 9 Nov 2026), so the page needs no proxy.
- Sign in with a **Meteor** testnet wallet. MyNearWallet now answers "MyNearWallet can't connect to apps anymore" to new app connections (seen 9 Nov 2026), so use Meteor. No relayer runs on Pages, so **Cancel** and door **Check in** are signed by your wallet (about 0.00025 testnet NEAR gas). The gasless NEP-366 path needs `pnpm relayer` locally (see below).

Events shown:
- **`demo-day.showup-factory-1793597558.testnet`** (default) was created 9 Nov 2026 by `scripts/live-event-testnet.mjs` (tx `dBXYe8Aau67NVe2kuB3Nqw7CcUUVyWQhfa9RqaVrr2Q`). It takes 0.1 NEAR deposits with capacity 25. RSVP/cancel is open until 2026-11-09 16:00 UTC, and door check-in is open from then until 2026-11-30 18:30 UTC. The escrow requires `cancel_deadline <= checkin_start`, so RSVP and check-in never overlap.
- **`judges-2026.showup-factory-1793597558.testnet`**: RSVP/cancel open until 20 Dec 2026, so you can RSVP and cancel from your own wallet.
- **`showup-demo-1793595312.testnet`**: settled.

## NEAR tech used
- **Rust `near-sdk` 5.5 escrow contract** (`contracts/escrow`): `rsvp` (payable), `cancel`, `add_checker`, `check_in`, `settle`, plus the views `get_info`, `get_guests` and `get_status`. Capacity is capped at 200 (`MAX_CAPACITY`). `cancel` removes the guest from the map, which frees its storage; `get_info.cancelled` counts cancellations. This keeps storage and the `settle` loop bounded, so repeated rsvp+cancel can't drain the state buffer. Escrows deployed earlier still store `Cancelled`.
- **Factory contract** (`contracts/factory`): `create_event(name, deposit, capacity, windows)` (payable). In one batched receipt it creates the `<name>.<factory>` sub-account, funds it, deploys the escrow wasm embedded with `include_bytes!`, and calls `new` with `host = predecessor`. The `on_event_created` callback records the event, or refunds the host if the batch failed. Views: `get_events`, `get_event` and `get_min_deposit`. Capacity above 200 is rejected before any deposit moves.
- **Testnet JSON-RPC `query/call_function` view calls**, made straight from the browser by the widget and dashboard (`https://rpc.testnet.near.org`, falling back to `https://rpc.testnet.fastnear.com`).
- **NEAR Intents 1Click** (`lib/oneclick.mjs` in Node, `widget/core.mjs` in the browser). It runs live `dry:true` `EXACT_OUTPUT` quotes for "pay the deposit from USDC/ETH/SOL on Base/Arbitrum/Solana".
- **NEAR Wallet Selector** (`@near-wallet-selector/core` 10 with MyNearWallet + Meteor and the modal UI) for RSVP, cancel and check-in signing. It is pre-bundled into `widget/vendor/wallet.js` from `wallet-src/` (`pnpm --dir wallet-src install && pnpm --dir wallet-src build`), so the widget stays a one-tag embed with no build step. The 1.8 MB bundle is only fetched when someone clicks a wallet button, or is returning from a wallet.
- **QR check-in**: the guest's widget draws `showup:checkin?event=…&guest=…` locally (`widget/vendor/qr.js`; no QR web service), and `dashboard/checkin.html` scans it and signs `check_in`.
- Delegated door staff via `add_checker`.
- **NEP-366 meta transactions (gasless cancel / check-in)**: `relayer/` accepts a borsh `SignedDelegateAction`, checks it against a strict policy, wraps it in `Action::Delegate` and pays the gas from a testnet relayer account. The borsh codec and signing live in `lib/nep366.mjs` (no near-api-js; byte-for-byte equal to `@near-js/transactions` 2.5.1 on a recorded vector).
- **near-cli-rs 0.30**, using faucet-sponsored accounts for every testnet deploy.

## Layout
| Path | What |
|---|---|
| `contracts/escrow` | per-event escrow (28 Rust tests, including a 10k-case conservation property and abuse cases) |
| `contracts/factory` | factory with the embedded escrow wasm (12 Rust tests: receipt batch shape, init args, callback success/refund, pagination, validation, capacity cap) |
| `widget/widget.js` + `widget/core.mjs` | `<script src=".../widget/widget.js" data-event="acct.testnet">`, rendered in a shadow DOM with no build step |
| `dashboard/index.html` + `dashboard/logic.mjs` | host dashboard: guests, statuses, projected or final payout table, conservation check |
| `scripts/serve.mjs` | dependency-free static server (no npx); serves only `widget/`, `dashboard/` and `lib/` |
| `scripts/view.mjs` | `pnpm view`: read-only view call with the widget's RPC fallback |
| `lib/settle.mjs` | settle math mirrored from the contract; used by the dashboard |
| `lib/nep366.mjs` | borsh Action / DelegateAction / SignedDelegateAction / Transaction codec, ed25519 signing, client helper (`signedDelegateCall`, `relaySignedDelegate`) |
| `relayer/policy.mjs` + `relayer/server.mjs` | gasless relayer: pure policy (unit-tested) and the HTTP server (`pnpm relayer`); `relayer/demo-testnet.mjs` is the live run (`pnpm relayer:demo`) |

## Run
```
# needs rustup (installs Rust 1.86 + the wasm32-unknown-unknown target from rust-toolchain), Node 20.11+, pnpm
pnpm test            # builds escrow wasm, cargo tests (escrow + factory), node tests
pnpm build:contract  # escrow wasm, then the factory wasm that embeds it
pnpm serve           # http://localhost:8080/widget/demo.html and /dashboard/ (port busy? pnpm serve 8081)
pnpm view <account> <method> ['<json args>']   # read-only view call without near-cli
pnpm demo:sim        # simulated event payout table
pnpm quote:dry       # live 1Click dry quote (no funds moved)
RELAYER_ACCOUNT=<you>.testnet pnpm relayer   # gasless relayer on :3030 (key from ~/.near-credentials/testnet)
pnpm relayer:demo    # live TESTNET run: faucet accounts, event, RSVPs, gasless cancel + check_in (moves testnet NEAR only)
pnpm scenarios:testnet  # live TESTNET abuse run on existing keychain accounts: 55 PASS/FAIL checks (moves testnet NEAR only)
pnpm ui:mobile       # headless Chrome at 360/390/414 px vs a running `pnpm serve` (needs playwright-core outside the repo)
pnpm browser:testnet # live TESTNET run of the real pages in headless Chrome with a signed-in wallet session: gasless cancel + door check-in, RSVP tx handed to MyNearWallet, relayer-down fallback, CSV export (needs `pnpm serve` + playwright-core; BASE=http://localhost:8080)
```
The factory `include_bytes!` the escrow at `target/wasm32-unknown-unknown/release/showup_escrow.wasm`, so the escrow must be built first. `pnpm test` and `pnpm build:contract` handle that.

## Judge steps (do X, see Y)
1. Run `pnpm test`. You should see `test result: ok. 28 passed` (escrow) and `test result: ok. 12 passed` (factory), plus empty doc-test results, then `pass 68` / `fail 0` for the JS tests (settle, 1Click, widget, wallet/RSVP states, QR check-in, RPC fallback, dashboard, CSV export, static server, NEP-366 codec and relayer policy). These run offline from recorded RPC/1Click fixtures in `test/fixtures/`.
2. Run `pnpm serve` and open http://localhost:8080/widget/demo.html. If port 8080 is taken, run `pnpm serve 8081` and use that port in steps 2 and 3. The widget and dashboard read testnet through `rpc.testnet.near.org` and fall back to `rpc.testnet.fastnear.com` automatically if it answers -429 or fails (`data-rpc=` / `?rpc=` pin one RPC). You should see two widget cards read live from testnet:
   - **judges-2026.showup-factory-1793597558.testnet** (created for judging; RSVP and cancel stay open until 20 Dec 2026 00:00 UTC): "RSVP open", deposit 0.1 NEAR, capacity 25, spots left 24 (one test guest has RSVPed), and a live 1Click line such as "Pay 0.43 USDC (≈ $0.43) → 0.1 NEAR in ~37s". Changing the select (USDC Arbitrum/Solana, ETH Base, SOL) re-quotes. Clicking **Sign in with NEAR wallet to RSVP** opens the NEAR wallet selector (MyNearWallet or Meteor, testnet). After you sign in, the button becomes **RSVP: lock 0.1 NEAR**, which asks your wallet to sign exactly `rsvp` with the deposit attached. Once you have RSVPed you get **Cancel RSVP (refund 0.1 NEAR)** and your **check-in QR code**. "Prefer a terminal?" still shows the exact `near` CLI command.
   - **showup-demo-1793595312.testnet**: "Settled", with the button disabled.
   - Gasless cancel in the browser: run `RELAYER_ACCOUNT=<you>.testnet pnpm relayer` and open `/widget/demo.html?relayer=http://localhost:3030`. After you sign in and RSVP, **Cancel RSVP** is signed with the wallet's sign-in key and the relayer pays the gas; the note ends with "(gasless: the relayer paid the gas)". `?event=<account>` shows any other event.
3. Open http://localhost:8080/dashboard/?event=showup-demo-1793595312.testnet. You should see "Final payouts (settled)": guest1 (CheckedIn) gets 0.2 NEAR, guest2 (Rsvp) is a no-show with the deposit forfeited, and "Conservation: … → true". The "Factory events…" dropdown is filled live from the factory's `get_events`.
4. Read the factory on-chain (no near-cli? `pnpm view showup-factory-1793597558.testnet get_events` prints the same JSON):
   `near contract call-function as-read-only showup-factory-1793597558.testnet get_events json-args '{}' network-config testnet now`. You should see every event the factory created, including `ethdenver-side` (the first one, 2 Nov), `judges-2026` and the `gasless-*`, `scen-*` and `ui-*` test events, each with its host.
5. Read the factory-created event (or `pnpm view judges-2026.showup-factory-1793597558.testnet get_info`):
   `near contract call-function as-read-only judges-2026.showup-factory-1793597558.testnet get_info json-args '{}' network-config testnet now`. You should see `host: showup-host-1793597558.testnet`, `capacity: 25`, `active: 1` and `cancel_deadline_ns: 1797724800000000000` (20 Dec 2026).
6. Optional: run `pnpm demo:sim` (5 RSVPs, 1 cancel, 3 check-ins; each attendee gets 6.666666 NEAR) and `pnpm quote:dry`.
7. Door check-in with QR: open http://localhost:8080/dashboard/checkin.html?event=qr-door.showup-factory-1793597558.testnet (or use the **Door check-in (QR) →** link on the dashboard). Sign in as the host or a checker, then click **Scan guest QR** (the camera uses the browser's built-in `BarcodeDetector`, available in Chrome on Android and macOS) or paste the code. The page reads `get_status` and shows the same reason the contract would give (not host/checker, window not open or over, already checked in, cancelled, no RSVP) before your wallet signs `check_in`. This flow ran for real on testnet; see the `qr-door` row in the table below. That event is now settled, so looking up `showup-guest-1793597596.testnet` there shows "The check-in window is over." On the live `judges-2026…` event (the door page's default) it shows "Check-in has not opened yet." until 20 Dec 2026 00:00 UTC.

## Testnet accounts and transactions
Full logs: `docs/testnet-factory-2026-11-02.log` and `docs/testnet-e2e-2026-11-02.log`.

| What | Account / tx |
|---|---|
| Factory account (faucet) | `showup-factory-1793597558.testnet`, create tx `C9A67RXmLDVqHEZnxS4DhLJcGkLboEUV2XzzEx2LKdzx` |
| Factory deploy + `new` | `5qoCgbpEhHp6C2wctGaMAReCrg3BaCpQdzFAk7moNk31` (factory wasm 366,848 B, embedded escrow 179,880 B) |
| Host account (faucet) | `showup-host-1793597558.testnet`, create tx `9xS1X3Z9L7kG291J1sXUQhS72e3CsoS2f8a9oqnQQnzs` |
| `create_event` through the factory | `9Vo8bJeSVfLF6dL1Z1D31iZNGGjvBxNJxdYBVQ7b7TKy`, which created `ethdenver-side.showup-factory-1793597558.testnet` (2.5 NEAR attached; `get_min_deposit` = 2.2988 NEAR) |
| Guest account + RSVP | `showup-guest-1793597596.testnet` (create `988UoUeiUY1j4zs67JhVkbZJ4igTHmuLYQYZDBmFaaP4`), rsvp `msQjRUjXjGeWPcfmwhe56KaoJhWWCh3wMsyqfDbiseC` |
| QR door flow (`qr-door.showup-factory-1793597558.testnet`, 0.01 NEAR deposit) | `create_event` `ttFax2h2xAJDenHM6iT8w1bShxU2caPiiTGdcoEsz36` → guest `rsvp` `LQ5HsrvcjaC37xkKff89qT1rCZ6sS18KcNqyNTufmnD` → the widget's QR decoded (jsQR) to `showup:checkin?event=qr-door…&guest=showup-guest-1793597596.testnet`, then `parseCheckinPayload` → the door page showed "Ready" for the host → host `check_in` `4GoPHGFbC9UsozTMKietjJe9HehkKGpNM2tThSHxaUxD` → `settle` `DEYRmDP6Ax9kVo9vJoqGEgj4FG7i6r3XYZvBAdyWtMDW` (the attendee gets the 0.01 NEAR back) |
| Earlier direct-deploy demo (settled) | `showup-demo-1793595312.testnet`: rsvp `7ij9J5qU…`, `BoosPz7C…`, check_in `JADwcmhU…`, settle `5d5HTC8v…` (see the e2e log) |

Explorer: https://testnet.nearblocks.io/address/showup-factory-1793597558.testnet

## Settle rule
`each = deposit + floor(deposit*no_shows/attendees)`. The rounding dust (< attendees yocto) goes to the host. If nobody attends, the whole pool goes to the host. Funds are conserved exactly (property-tested in Rust and JS). The dashboard runs the same math.

## Known limits
- The host could fake check-ins (collusion). This is documented; a stretch goal is attendee co-signing.
- 1Click runs on mainnet only, so the widget's any-chain line is a dry *price preview* of the deposit as mainnet wNEAR. Testnet RSVPs attach NEAR directly.
- All of the factory's attached deposit funds the event account. Any excess over storage stays in that account; there is no host withdrawal yet.
- A plain check-in QR (account id) identifies a guest but doesn't prove they hold the account; the signed rotating door pass (Round 3 below) closes that for guests who create one, and the door page labels plain codes "unsigned code".
- A real MyNearWallet / Meteor sign-in can't be completed headlessly. The browser E2E (below) reproduces the exact post-sign-in session MyNearWallet leaves (a function-call key added on-chain and stored as Wallet Selector 10 stores it), so `rsvp` is checked up to the exact transaction handed to MyNearWallet, not through the wallet's own confirm screen.
- `get_guests` is unpaginated; that's fine for demo-sized events.

## Gasless cancel and check-in (NEP-366 relayer)
Guests and door staff can cancel or check in without holding NEAR for gas. The signer builds a `DelegateAction`, signs `sha256(u32(2^30+366) ‖ borsh(DelegateAction))`, and POSTs it to the relayer as base64 (`POST /relay {"signed_delegate": "…"}`). The relayer sends one transaction `relayer → sender: [Delegate(signed)]`, signed with its own testnet key.

**Policy** (`relayer/policy.mjs`, pure and unit-tested). Everything else is rejected with HTTP 403 and nothing is sent.
- The receiver must be the factory or exactly `<label>.<factory>`, where `<label>` follows the factory's `valid_name` rule. Look-alikes, nested sub-accounts and other accounts are rejected. With `VERIFY_FACTORY` (on by default) the escrow must also be a record in the factory's `get_event(name)`.
- There must be exactly one action. It must be a `FunctionCall` to `check_in` or `cancel` on an escrow; nothing is allow-listed on the factory itself. Transfers, AddKey, DeleteKey, DeleteAccount, Stake, CreateAccount, DeployContract and nested Delegate are rejected.
- The deposit must be 0, gas must be ≤ 50 Tgas, and the args are checked: `cancel` takes `{}`, `check_in` takes `{"guest": <account>}`.
- `max_block_height` must be in the future and at most 1200 blocks ahead. The nonce must be > 0, and the ed25519 signature must verify. The delegate's public key must be an access key of `sender_id` (`view_access_key`). Its nonce must be above the key's on-chain nonce, so a replay after a relayer restart is refused. A function-call key must be scoped to the receiver and method. Random-key and replayed delegates are therefore rejected with 403 before the relayer pays gas.
- Anti-griefing pre-flight: the relayer reads `get_info`/`get_status` and refuses calls the escrow would panic on (not host/checker, window closed, no active RSVP), so it doesn't pay for failures.
- The same signed action posted twice returns the first result (`replayed: true`) and is never sent twice.
- If the NEAR RPC is unreachable before sending, the relayer returns 503 `retryable: true`; nothing was sent. If the relayer can't pay (NotEnoughBalance / LackBalanceForState), it returns 503 `code: "RELAYER_OUT_OF_FUNDS"`. Clients fall back to the wallet in both cases. `GET /health` reports the relayer balance and sets `low_funds` below 0.5 NEAR (`rpc: "unreachable"` when it can't read the balance).

**Client side.** `lib/nep366.mjs` `signedDelegateCall()` reads the access-key nonce and the final block height, then signs; `relaySignedDelegate()` posts the result. The widget's **Cancel RSVP** (`data-relayer="http://localhost:3030"`) and the door page's **Check in** (`checkin.html?relayer=…`) first try the gasless path. They sign with the function-call key that MyNearWallet adds at sign-in (scoped to the event contract). Wallet Selector 10 keeps it in localStorage as `functionCallKey` next to `signedAccountId`; older near-api-js wallets used `near-api-js:keystore:<account>:testnet`, and both are read. On any error, or if that key isn't available, they fall back to the normal wallet-signed transaction. `rsvp` attaches the deposit, so it always goes through the wallet. The browser path ran live on testnet on 9 Nov (see *Browser E2E* below); before that fix it only looked for the old near-api-js key name, so real Wallet Selector 10 sessions always fell back to the wallet. Wallet Selector 10's MyNearWallet and Meteor modules don't implement `signDelegateAction`, which is why it uses the local key. The live run below signed with near-cli keychain keys.

**Live testnet run (2026-11-04)**, `pnpm relayer:demo`, full log `docs/testnet-relayer-2026-11-04.log`:

| Step | Account / tx |
|---|---|
| Faucet accounts | relayer `showup-relayer-1793775606.testnet`, host `showup-rhost-1793775606.testnet`, guests `showup-rguest-a-1793775606.testnet`, `showup-rguest-b-1793775606.testnet` |
| `create_event` via the factory (host pays) | [`8CC1uvP9SWV3zcyyeADafrayb6VeGoMbN3MgB84kFJup`](https://testnet.nearblocks.io/txns/8CC1uvP9SWV3zcyyeADafrayb6VeGoMbN3MgB84kFJup) → `gasless-1793775606.showup-factory-1793597558.testnet` (0.01 NEAR deposit) |
| Guest A `rsvp` (guest pays deposit + gas) | [`6HsmwGRxKqWEfhHDggnqK3vs79VpFuSxAbEjzcHeGVbn`](https://testnet.nearblocks.io/txns/6HsmwGRxKqWEfhHDggnqK3vs79VpFuSxAbEjzcHeGVbn) |
| Guest B `rsvp` (guest pays deposit + gas) | [`FhBbtJzuKN954EFvr35FkKn93f23mXaybz9VfVdjzQDH`](https://testnet.nearblocks.io/txns/FhBbtJzuKN954EFvr35FkKn93f23mXaybz9VfVdjzQDH) |
| Rejected over HTTP, nothing sent | transfer 1 NEAR, AddKey full access, cancel on a non-factory receiver, rsvp with deposit, cancel with 1 yocto, settle, check_in signed by a guest |
| **Gasless `cancel`** signed by guest A, sent by the relayer | [`4HsvijX9g9U6826KYiPdrWrFBUPnFJx9xE8gKMBPjAsV`](https://testnet.nearblocks.io/txns/4HsvijX9g9U6826KYiPdrWrFBUPnFJx9xE8gKMBPjAsV). Guest A balance 9.98981 → 9.99981 NEAR: **+0.01 NEAR exactly** (the refund, nothing taken for gas). The relayer paid 0.0003 NEAR. |
| **Gasless `check_in`** of guest B signed by the host | [`5tEUx7X71Nn1ZsrNECh5MyWDEosJJPan2K4XU39cPrpw`](https://testnet.nearblocks.io/txns/5tEUx7X71Nn1ZsrNECh5MyWDEosJJPan2K4XU39cPrpw). Host balance change: **0 yocto**. The relayer paid 0.00025 NEAR. Guest B is now `CheckedIn`. Re-posting the same signed action returned the same hash with no second tx. |
| **`settle`** after the check-in window closed (called by guest A: `settle` is permissionless) | [`479KKT9qY2EkVJ1VLnJRye1rF4MfW2F5SDzxx9nv6hfH`](https://testnet.nearblocks.io/txns/479KKT9qY2EkVJ1VLnJRye1rF4MfW2F5SDzxx9nv6hfH). **Payout: 0.01 NEAR → guest B** (`showup-rguest-b-1793775606.testnet`, CheckedIn, its deposit back; there were no no-shows, so no pool to share). Guest A had already been refunded by the gasless cancel. All receipts succeeded. Open `dashboard/?event=gasless-1793775606.showup-factory-1793597558.testnet` to see "Final payouts (settled)". |

Both gasless transactions show `signer_id = showup-relayer-1793775606.testnet` with a single `Delegate` action and no failed receipts (checked with RPC `tx`). An earlier run the same day (`docs/testnet-relayer-2026-11-04-run1.log`, gasless cancel [`8fGcjGBvABQMpnD1TmQCu1GRvFEMajE51JXaRsTM2eCw`](https://testnet.nearblocks.io/txns/8fGcjGBvABQMpnD1TmQCu1GRvFEMajE51JXaRsTM2eCw)) found a bug. The check_in POST arrived twice, the duplicate failed pre-flight, and the script crashed before logging the hash. The duplicate-request handling above fixes this.

## Host CSV export
On the dashboard, **Export CSV** downloads `showup-<event>-ledger.csv` (RFC 4180, CRLF, UTF-8, a single header row, no comment lines). It has one row per guest, plus a host row if the host receives rounding dust or the unclaimed pool. The columns are:

`event, network, guest_account, status, rsvp_time_utc, deposit_near, deposit_tx, refund_near, refund_time_utc, refund_tx, payout_near, payout_time_utc, payout_tx, explorer_url`

- Amounts are decimal NEAR (e.g. `0.01`), and times are ISO 8601 UTC.
- `status` is one of `attended`, `no_show_forfeited`, `rsvp_not_checked_in`, `cancelled_refunded`, `host_rounding_dust` or `host_no_attendees_pool`.
- `payout_*` is only filled once the event is settled.
- Tx hashes and times come from the NearBlocks API v3 receipts endpoint, `https://api-testnet.nearblocks.io/v3/accounts/<escrow>/receipts?limit=25` (paged with `meta.next_page`, at most 8 pages). The old v1 `/account/<escrow>/txns` API now returns 410.
- The export reads receipts rather than txns because a gasless (NEP-366) cancel or check-in is a transaction signed by the relayer and sent to the guest or host. It doesn't show up under the escrow's txns, but its `cancel` / `check_in` receipt does.
- When the indexer is unreachable, the hash and time cells stay blank.
- `explorer_url` is a NEAR Rocks tx link (`https://testnet.near.rocks/tx/<hash>`) for the payout tx if there is one, otherwise the refund tx, otherwise the deposit tx. It's blank when a row has no tx hash. NEAR Rocks is used because the `testnet.nearblocks.io` UI sits behind a Cloudflare challenge.

The logic is a pure function (`ledgerRows` / `ledgerCsv` / `csvCell` in `dashboard/logic.mjs`) and is tested against the settled demo event.

## Libraries, templates and AI-generated code (Q-005)
**Rust contracts** (`Cargo.toml`, `contracts/*/Cargo.toml`): `near-sdk =5.5.0` is the only dependency, plus its `unit-testing` feature for tests.

**Browser bundles** (`widget/vendor/*.js`, built from `wallet-src/` with esbuild 0.28.2; versions from `wallet-src/pnpm-lock.yaml`):
- `wallet.js`: `@near-wallet-selector/core`, `my-near-wallet`, `meteor-wallet` and `modal-ui` 10.1.4; `@near-js/transactions` 2.5.1 (which pulls in `@near-js/*` 2.x and `near-api-js` 6.5.1 transitively); `buffer` 6.0.3 and `util` 0.12.5 (browser shims). The modal UI bundles React 19.
- `qr.js`: `qrcode` 1.5.4.
- `crypto.js`: `@noble/curves` 1.8.1 (ed25519) and `@noble/hashes` 1.8.0 (sha256), plus a small base58 written here.

**Node / JS**: the root `package.json` has no runtime or dev dependencies. Tests use `node:test`, and the static server and relayer use `node:http`. No templates or starter kits were used.

**Tools that are not code dependencies**: near-cli-rs 0.30 (deploys, faucet accounts), pnpm and esbuild. `@near-js/transactions` 2.5.1 was installed outside the repo once, to record `test/fixtures/nep366-nearjs.json`. jsQR was used once to decode the widget's QR during the recorded door test.

**AI-generated code**: most of the code in this repo was written with an AI coding assistant (Claude Code) and reviewed, tested and run on testnet by the author. That covers the contracts, widget, dashboard, relayer, tests, scripts and this README. The design, product decisions and testnet runs were directed by the author. The vendored bundles in `widget/vendor/` are minified third-party code generated by esbuild, not hand-written.

## Secrets scan
gitleaks v8 (8.21.2, `gitleaks git .`) was run over the full git history and found 0 real secrets. Every finding was a false positive:
- 4 × `generic-api-key` on minified `KeyPair` identifiers inside `widget/vendor/wallet.js`.
- An earlier scan also flagged an ed25519 signature in a recorded 1Click quote fixture.

A `gitleaks dir .` scan of the working tree adds only a gitignored `target/` build artifact (an ed25519-dalek library test key). The throwaway test seed in `test/fixtures/nep366-nearjs.json` (bytes 1..32) is not a real key. Real testnet keys live only in `~/.near-credentials/testnet` (outside the repo), and the relayer and demo scripts never print them.

## Related projects by the same author (Q-015)
Independent NEAR HACKATHON projects by the same author:
- https://github.com/anonymusk7/near-petri (Petri)
- https://github.com/anonymusk7/near-showup (this repo)

## License
MIT (see `LICENSE`).

## Round 3: wallet-signed, screenshot-proof door pass
- The guest's wallet signs a NEP-413 cert once. It binds the event, the guest, an ephemeral phone key and a 24 h expiry.
- The QR re-signs every 10 s with that phone key. The door (`dashboard/checkin.html`) checks:
  - the wallet signature;
  - that the wallet key is a FullAccess key on-chain (`view_access_key`);
  - the frame signature;
  - that the code is ≤ 30 s old;
  - that it has not been scanned before.
- **Judge check:** `pnpm test` should give 66 JS tests passing (the pass tests are in `test/pass.test.mjs`). `node scripts/pass-testnet.mjs showup-guest-1793597596.testnet` needs that testnet key in `~/.near-credentials`; it prints live ✓, replay ✗, stale ✗, relabel ✗.
- **Limits:**
  - Someone relaying the live screen in real time is not stopped.
  - The door verifies the pass; the contract's `check_in` is still host/checker-authorized.
  - The seen-set is per door device.
- Demo script: `docs/DEMO-SCRIPT.md`.

## Scenario testing (2026-11-09)
`pnpm scenarios:testnet` (`scripts/scenarios-testnet.mjs`) runs the abuse cases against live testnet using the existing keychain accounts. It writes one PASS/FAIL line per check to `docs/testnet-scenarios-<date>.log`, plus the ledger CSV.
- **Factory redeployed** on `showup-factory-1793597558.testnet` with the hardened escrow. State is unchanged and the earlier events are still listed. The txs are `91PZ4341T4WFUMYBVpmQrSWrZ9mkxMYNedSNXFAiWaro` and `8MRTD5reQukgV3MCC897KSmnCyw6H83crE6ussYqeG2p`. Escrows created earlier keep their old code.
- **Run 1** (`docs/testnet-scenarios-2026-11-09-run1.log`): 53 pass, 2 fail.
  - A double RSVP on a full event answered "event full" instead of "already RSVPed". The check order is now fixed.
  - The relayer reported "out of funds" as a raw `INVALID_TRANSACTION`. The RPC keeps the reason in `error.data`, which was being dropped.
- **Run 2** (`docs/testnet-scenarios-2026-11-09.log`, event `scen-1794201984.showup-factory-1793597558.testnet`): **55 pass, 0 fail**. Checks include:
  - factory capacity cap;
  - wrong deposit, double RSVP and RSVP when full;
  - gasless cancel refunds exactly 0.01 NEAR and frees the storage entry;
  - a replayed body is not re-sent;
  - the relayer refuses a random key, a used nonce, an expired action, `settle`/`rsvp`/transfer and foreign or look-alike receivers, and pays 0 yocto for them;
  - gasless check-in costs the host 0 yocto;
  - double check-in, check-in by a non-host and check-in outside the window are refused;
  - cancel after the deadline and settle before the end are refused;
  - settle by an outsider pays the attendee exactly 0.02 NEAR, and re-settle is refused;
  - the CSV is correct;
  - the relayer returns 503 `RELAYER_OUT_OF_FUNDS` when out of funds, and 503 retryable when the RPC is down.
- **Mobile UI** (`pnpm ui:mobile`): the widget, dashboard and door page have no horizontal overflow at 360, 390 and 414 px when live, with the RPC down, and with 1Click down. The wallet-selector modal opens at 375 px.


## Browser E2E with a signed-in wallet (2026-11-09)
`pnpm browser:testnet` (`scripts/browser-e2e-testnet.mjs`) drives the real widget, door page and dashboard in headless Chrome against live testnet. MyNearWallet's own screens can't be automated, so the run reproduces the session the wallet leaves after sign-in: it adds an event-scoped function-call key on-chain (as MyNearWallet does) and stores it the way Wallet Selector 10 does (`signedAccountId` + `functionCallKey`).
- **Run 1** (`docs/testnet-browser-e2e-2026-11-09-run1.log`): 21 pass, 1 fail. Two bugs were found and fixed:
  - The gasless path looked only for the old near-api-js key name, which Wallet Selector 10 deletes on load, so in a real browser **Cancel** and door **Check in** never went gasless. Both now read `functionCallKey` (scoped to the event).
  - After a successful cancel, the confirmation and its tx link were written into a hidden note, so the guest saw no confirmation. It now says "Cancelled. Your … NEAR deposit was refunded." with the tx link.
- **Run 2** (`docs/testnet-browser-e2e-2026-11-09.log`, event `ui-1794207060.showup-factory-1793597558.testnet`): **22 pass, 0 fail**:
  - the signed-in widget shows "Signed in as …", **Cancel RSVP (refund 0.01 NEAR)** and the signed door pass button;
  - clicking **Cancel** goes through the relayer ([`J7CWuzJC…`](https://testnet.nearblocks.io/txns/J7CWuzJC53zs4Wt9F2Te1nSEe5HZ9846GRkC1DKcb3nB)); the guest gets exactly +0.01 NEAR and pays no gas;
  - **RSVP** hands MyNearWallet exactly one `rsvp({})` call with a 0.01 NEAR deposit to the event (decoded from the wallet URL);
  - with the relayer unreachable, **Cancel** falls back to the wallet path (signed in the browser with the sign-in key; the guest pays ~0.00025 NEAR gas);
  - the host's gasless **Check in** on the door page ([`dPJsVpux…`](https://testnet.nearblocks.io/txns/dPJsVpuxbxpvhevGhyHtdwQCUNY1K9WMKfKYVJVWuwo)) costs the host 0 yocto;
  - after `settle`, the dashboard's **Export CSV** downloads `showup-<event>-ledger.csv` with the attendee paid 0.01 NEAR;
  - no page errors.
- Cancelled guests have no CSV row, because `cancel` frees their entry on-chain and testnet nearblocks returns no tx history for these accounts.
