// Read-only testnet view call without near-cli: node scripts/view.mjs <account> <method> ['<json args>']
// Uses the same RPC fallback as the widget (rpc.testnet.near.org, then FastNEAR). NEAR_RPC=<url> pins one RPC.
import { viewCall } from '../widget/core.mjs';
const [account, method, args = '{}'] = process.argv.slice(2);
if (!account || !method) { console.error("usage: pnpm view <account> <method> ['<json args>']"); process.exit(2); }
try {
  console.log(JSON.stringify(await viewCall(account, method, JSON.parse(args), { rpc: process.env.NEAR_RPC || undefined }), null, 2));
} catch (e) { console.error(`view failed: ${e.message}`); process.exit(1); }
