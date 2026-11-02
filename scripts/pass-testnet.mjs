// Real testnet check of the signed pass: the guest's actual NEAR key (from ~/.near-credentials, never printed)
// signs the NEP-413 cert, and the door verifies it against live view_access_key. Free: no transaction.
// Usage: node scripts/pass-testnet.mjs <guest.testnet> [event]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import * as P from '../widget/pass.mjs';
import { ed25519, b58decode } from '../widget/vendor/crypto.js';
import { RPC_FALLBACKS } from '../widget/core.mjs';
const guest = process.argv[2], event = process.argv[3] || 'ethdenver-side.showup-factory-1793597558.testnet';
const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.near-credentials/testnet', `${guest}.json`), 'utf8'));
const sk = b58decode(cred.private_key.replace('ed25519:', '')).slice(0, 32);
const req = P.newPassRequest({ event, guest });
const signed = { accountId: guest, publicKey: cred.public_key, signature: Buffer.from(ed25519.sign(P.nep413Hash(req.request), sk)).toString('base64') };
const cert = P.makeCert(req, { event, guest }, signed);
const accessKey = P.rpcAccessKey(RPC_FALLBACKS), seen = new Set();
const frame = P.passFrame(cert);
const show = (label, r) => console.log(`${r.ok ? '✓' : '✗'} ${label}: ${r.ok ? `accepted ${r.guest} (${r.walletPk.slice(0, 18)}… is a full-access key on-chain)` : r.reason}`);
show('live frame', await P.verifyPass(frame, { event, accessKey, seen }));
show('same frame again', await P.verifyPass(frame, { event, accessKey, seen }));
show('screenshot 40 s later', await P.verifyPass(P.passFrame(cert, Date.now() - 40_000), { event, accessKey, seen }));
const other = 'showup-host-1793597558.testnet';
show(`cert re-labelled as ${other}`, await P.verifyPass(frame.replace(`g=${guest}`, `g=${other}`), { event, accessKey, seen }));
console.log(`QR text length ${frame.length} chars`);
