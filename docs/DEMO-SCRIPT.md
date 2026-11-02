# ShowUp: demo script (about 2:00)

| # | Shot | Voice-over | On screen |
|---|------|-----------|-----------|
| 1 | Hook (0:00–0:10) | "Ticket QR codes get screenshotted and resold. ShowUp's can't be." | A QR code being screenshotted, a red X |
| 2 | RSVP (0:10–0:30) | "A guest RSVPs with their NEAR wallet. The RSVP is on-chain." | Widget → RSVP → explorer tx |
| 3 | Signed pass (0:30–0:50) | "One tap: the wallet signs a door pass for this event, this guest, valid 24 hours." | "Create my signed door pass", the wallet's NEP-413 sign prompt |
| 4 | Rotating QR (0:50–1:05) | "The code re-signs itself every 10 seconds with a key only this phone holds." | The QR animating, countdown |
| 5 | Door scan (1:05–1:25) | "At the door, the checker scans it. Wallet signature, freshness, first use and the on-chain key are all checked." | checkin.html: green "signed pass ✓ wallet key on-chain, code 5 s old, first scan" |
| 6 | Attack (1:25–1:45) | "A screenshot from a minute ago? Rejected. The same code twice? Rejected." | Red "pass rejected: code is 58 s old: likely a screenshot" |
| 7 | Check-in (1:45–1:55) | "The checker marks them in, on-chain." | check_in tx in the explorer |
| 8 | Close (1:55–2:00) | "ShowUp: real people, really there." | Logo |

Terminal proof shot (optional): `node scripts/pass-testnet.mjs showup-guest-1793597596.testnet` shows live ✓, replay ✗, 40 s screenshot ✗, relabelled guest ✗.
