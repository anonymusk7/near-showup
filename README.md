# ShowUp: event deposits where no-shows pay the people who show up

```yaml
project: ShowUp
tracks: [realworld, open]
one_liner: RSVP deposits for events, escrowed by a NEAR contract; no-shows' deposits are split among attendees.
near: [rust near-sdk 5.5 escrow + factory contracts (sub-accounts, batched receipts, callbacks), testnet JSON-RPC from the browser, NEAR Intents 1Click dry quotes]
network: testnet (1Click quotes: mainnet, dry:true only)
try_it: pnpm test && pnpm serve   # then http://localhost:8080/widget/demo.html
needs_key: false
status: work in progress (NEAR HACKATHON, Nov 2026)
```

Tracks: `realworld` (merchant/event payments with any-chain deposits via NEAR Intents), `open`.

**What:** NEAR contracts plus an embeddable widget and a host dashboard for event RSVPs. Guests lock a deposit to RSVP and get a full refund if they cancel before the deadline. After the event, every attendee gets their deposit back plus an equal share of the no-show deposits.
**Problem:** free crypto side events see about 50% no-shows, and deposits fail because guests don't hold the right token on the right chain. ShowUp previews paying from any chain through NEAR Intents 1Click.

Status: work in progress (NEAR HACKATHON, Nov 2026).

## NEAR tech used
- **Rust `near-sdk` 5.5 escrow contract** (`contracts/escrow`): `rsvp` (payable), `cancel`, `add_checker`, `check_in`, `settle`, plus the views `get_info`, `get_guests` and `get_status`.
- **Factory contract** (`contracts/factory`): `create_event(name, deposit, capacity, windows)` (payable). In one batched receipt it creates the `<name>.<factory>` sub-account, funds it, deploys the escrow wasm embedded with `include_bytes!`, and calls `new` with `host = predecessor`. The `on_event_created` callback records the event, or refunds the host if the batch failed. Views: `get_events`, `get_event` and `get_min_deposit`.
- **Testnet JSON-RPC `query/call_function` view calls**, made straight from the browser by the widget and dashboard (`https://rpc.testnet.near.org`, falling back to `https://rpc.testnet.fastnear.com`).
- **NEAR Intents 1Click** (`lib/oneclick.mjs` in Node, `widget/core.mjs` in the browser). It runs live `dry:true` `EXACT_OUTPUT` quotes for "pay the deposit from USDC/ETH/SOL on Base/Arbitrum/Solana".
- **NEAR Wallet Selector** (`@near-wallet-selector/core` 10 with MyNearWallet + Meteor and the modal UI) for RSVP, cancel and check-in signing. It is pre-bundled into `widget/vendor/wallet.js` from `wallet-src/` (`pnpm --dir wallet-src install && pnpm --dir wallet-src build`), so the widget stays a one-tag embed with no build step. The 1.8 MB bundle is only fetched when someone clicks a wallet button, or is returning from a wallet.
- **QR check-in**: the guest's widget draws `showup:checkin?event=…&guest=…` locally (`widget/vendor/qr.js`; no QR web service), and `dashboard/checkin.html` scans it and signs `check_in`.
- Delegated door staff via `add_checker`.
- **near-cli-rs 0.30**, using faucet-sponsored accounts for every testnet deploy.

## Layout
| Path | What |
|---|---|
| `contracts/escrow` | per-event escrow (11 Rust tests, including a 10k-case conservation property) |
| `contracts/factory` | factory with the embedded escrow wasm (10 Rust tests: receipt batch shape, init args, callback success/refund, pagination, validation) |
| `widget/widget.js` + `widget/core.mjs` | `<script src=".../widget/widget.js" data-event="acct.testnet">`, rendered in a shadow DOM with no build step |
| `dashboard/index.html` + `dashboard/logic.mjs` | host dashboard: guests, statuses, projected or final payout table, conservation check |
| `scripts/serve.mjs` | dependency-free static server (no npx); serves only `widget/`, `dashboard/` and `lib/` |
| `scripts/view.mjs` | `pnpm view`: read-only view call with the widget's RPC fallback |
| `lib/settle.mjs` | settle math mirrored from the contract; used by the dashboard |

## Run
```
# needs Rust 1.86 + wasm32-unknown-unknown target, Node 20.11+, pnpm
pnpm test            # builds escrow wasm, cargo tests (escrow + factory), node tests
pnpm build:contract  # escrow wasm, then the factory wasm that embeds it
pnpm serve           # http://localhost:8080/widget/demo.html and /dashboard/ (port busy? pnpm serve 8081)
pnpm view <account> <method> ['<json args>']   # read-only view call without near-cli
pnpm demo:sim        # simulated event payout table
pnpm quote:dry       # live 1Click dry quote (no funds moved)
```
The factory `include_bytes!` the escrow at `target/wasm32-unknown-unknown/release/showup_escrow.wasm`, so the escrow must be built first. `pnpm test` and `pnpm build:contract` handle that.

## Judge steps (do X, see Y)
1. Run `pnpm test`. You should see `test result: ok. 11 passed` (escrow) and `test result: ok. 10 passed` (factory), plus two empty doc-test results, then `pass 24` / `fail 0` for the JS tests (settle, 1Click, widget, wallet/RSVP states, QR check-in, RPC fallback, dashboard, static server). These run offline from recorded RPC/1Click fixtures in `test/fixtures/`.
2. Run `pnpm serve` and open http://localhost:8080/widget/demo.html. If port 8080 is taken, run `pnpm serve 8081` and use that port in steps 2 and 3. The widget and dashboard read testnet through `rpc.testnet.near.org` and fall back to `rpc.testnet.fastnear.com` automatically if it answers -429 or fails (`data-rpc=` / `?rpc=` pin one RPC). You should see two widget cards read live from testnet:
   - **ethdenver-side.showup-factory-1793597558.testnet**: "RSVP open", deposit 0.1 NEAR, capacity 25, spots left 24, and a live 1Click line such as "Pay 0.43 USDC (≈ $0.43) → 0.1 NEAR in ~37s". Changing the select (USDC Arbitrum/Solana, ETH Base, SOL) re-quotes. Clicking **Sign in with NEAR wallet to RSVP** opens the NEAR wallet selector (MyNearWallet or Meteor, testnet). After you sign in, the button becomes **RSVP: lock 0.1 NEAR**, which asks your wallet to sign exactly `rsvp` with the deposit attached. Once you have RSVPed you get **Cancel RSVP (refund 0.1 NEAR)** and your **check-in QR code**. "Prefer a terminal?" still shows the exact `near` CLI command.
   - **showup-demo-1793595312.testnet**: "Settled", with the button disabled.
3. Open http://localhost:8080/dashboard/?event=showup-demo-1793595312.testnet. You should see "Final payouts (settled)": guest1 (CheckedIn) gets 0.2 NEAR, guest2 (Rsvp) is a no-show with the deposit forfeited, and "Conservation: … → true". The "Factory events…" dropdown is filled live from the factory's `get_events`.
4. Read the factory on-chain (no near-cli? `pnpm view showup-factory-1793597558.testnet get_events` prints the same JSON):
   `near contract call-function as-read-only showup-factory-1793597558.testnet get_events json-args '{}' network-config testnet now`. You should see one record, `ethdenver-side.showup-factory-1793597558.testnet`, with host `showup-host-1793597558.testnet`.
5. Read the factory-created event (or `pnpm view ethdenver-side.showup-factory-1793597558.testnet get_info`):
   `near contract call-function as-read-only ethdenver-side.showup-factory-1793597558.testnet get_info json-args '{}' network-config testnet now`. You should see `host: showup-host-1793597558.testnet`, `capacity: 25` and `active: 1`.
6. Optional: run `pnpm demo:sim` (5 RSVPs, 1 cancel, 3 check-ins; each attendee gets 6.666666 NEAR) and `pnpm quote:dry`.
7. Door check-in with QR: open http://localhost:8080/dashboard/checkin.html?event=qr-door.showup-factory-1793597558.testnet (or use the **Door check-in (QR) →** link on the dashboard). Sign in as the host or a checker, then click **Scan guest QR** (the camera uses the browser's built-in `BarcodeDetector`, available in Chrome on Android and macOS) or paste the code. The page reads `get_status` and shows the same reason the contract would give (not host/checker, window not open or over, already checked in, cancelled, no RSVP) before your wallet signs `check_in`. This flow ran for real on testnet; see the `qr-door` row in the table below. That event is now settled, so looking up `showup-guest-1793597596.testnet` there shows "The check-in window is over." On the live `ethdenver-side…` event it shows "Check-in has not opened yet." until 9 Nov 05:33 UTC.

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
- The check-in QR identifies a guest but doesn't prove they hold the account, so door staff still match the person (a screenshot of someone else's code would pass). The next step is a NEP-413 signed-message QR. Wallet signing was exercised up to the wallet's sign-in screen in a headless browser; the on-chain `rsvp`/`check_in` calls in the table were signed with near-cli using the same arguments the page sends.
- `get_guests` is unpaginated; that's fine for demo-sized events.

## Related projects by the same author (Q-015)
Independent NEAR HACKATHON projects by the same author:
- https://github.com/anonymusk7/near-sealed
- https://github.com/anonymusk7/near-petri
- https://github.com/anonymusk7/near-showup (this repo)

## License
MIT (see `LICENSE`).
