# ShowUp: event deposits where no-shows pay the people who show up

**What:** a NEAR escrow contract for event RSVPs. Guests lock a deposit to RSVP, get a full refund if they cancel before the deadline, and after the event every attendee gets their deposit back plus an equal share of the no-show deposits.
**Problem:** free crypto side events see about 50% no-shows, and deposits fail because guests don't hold the right token on the right chain. ShowUp accepts any chain/token through NEAR Intents 1Click (in progress).

Status: work in progress (NEAR HACKATHON, Nov 2026).

## NEAR tech used
- Rust `near-sdk` 5.5 escrow contract (`contracts/escrow`): `rsvp` (payable), `cancel`, `add_checker`, `check_in`, `settle`, plus the views `get_info`, `get_guests` and `get_status`.
- Delegated door staff via `add_checker`. Next: a function-call access key limited to `check_in`, and NEP-366 meta transactions for gasless check-in.
- NEAR Intents 1Click quote/status client (`lib/oneclick.mjs`), using live `dry:true` quotes.
- Planned: a factory that creates `<event>.showup.testnet` sub-accounts, the widget, and the host dashboard.

## Run
```
# needs Rust 1.86 + wasm32-unknown-unknown target, Node 20+, pnpm
pnpm test            # cargo unit/property tests + node tests
pnpm demo:sim        # simulated event payout table
pnpm build:contract  # wasm in target/wasm32-unknown-unknown/release/
pnpm quote:dry       # live 1Click dry quote: 1 USDC Base -> USDC NEAR (no funds moved)
```

## Judge steps (do X, see Y)
1. Run `pnpm test`. You should see `11 passed` (Rust: full flow, the guard rails, and a 10k-case settle conservation property) and `pass 4` (JS).
2. Run `pnpm demo:sim`. You should see 5 RSVPs, 1 cancel, 3 check-ins and 1 no-show; each attendee gets 6.666666 NEAR on a 5 NEAR deposit, and the line `conservation ... true`.
3. Run `pnpm quote:dry`. You should see a real 1Click quote JSON with `amountOut`.
4. Testnet contract: https://testnet.nearblocks.io/address/showup-demo-1793595312.testnet. Read it with `near contract call-function as-read-only showup-demo-1793595312.testnet get_guests json-args '{}' network-config testnet now`.

## Settle rule
`each = deposit + floor(deposit*no_shows/attendees)`. The rounding dust (< attendees yocto) goes to the host. If nobody attends, the whole pool goes to the host. Funds are conserved exactly (property-tested).

## Known limits
The host could fake check-ins (collusion). This is documented; a stretch goal is attendee co-signing.

## Disclosure
The same author is building other independent NEAR HACKATHON projects; they will be named here if submitted (rule Q-015).

## License
MIT
