// Builds the static hosted demo (GitHub Pages): copies only widget/, dashboard/ and the two browser libs into OUT.
// No server-side parts: 1Click is called directly (CORS), RPC goes straight to testnet, no relayer (wallet-signed fallback).
// Usage: node scripts/build-pages.mjs <out-dir> [source-commit]
import { cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
const ROOT = resolve(import.meta.dirname, '..'), OUT = resolve(process.argv[2] || 'pages-dist'), SRC = process.argv[3] || 'unknown';
if (OUT === ROOT || ROOT.startsWith(OUT)) throw new Error('refusing to write over the repo');
await rm(resolve(OUT, 'widget'), { recursive: true, force: true }); await rm(resolve(OUT, 'dashboard'), { recursive: true, force: true }); await rm(resolve(OUT, 'lib'), { recursive: true, force: true });
await mkdir(resolve(OUT, 'lib'), { recursive: true });
await cp(resolve(ROOT, 'widget'), resolve(OUT, 'widget'), { recursive: true });
await cp(resolve(ROOT, 'dashboard'), resolve(OUT, 'dashboard'), { recursive: true });
for (const f of ['nep366.mjs', 'settle.mjs']) await cp(resolve(ROOT, 'lib', f), resolve(OUT, 'lib', f));
await writeFile(resolve(OUT, '.nojekyll'), '');
await writeFile(resolve(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>ShowUp demo</title>
<meta http-equiv="refresh" content="0; url=widget/demo.html"><a href="widget/demo.html">ShowUp widget demo →</a>\n`);
await writeFile(resolve(OUT, 'README.md'), `# ShowUp hosted demo (NEAR testnet)

Static build of the ShowUp widget, host dashboard and door check-in page, served by GitHub Pages.
Built by \`scripts/build-pages.mjs\` from https://github.com/anonymusk7/near-showup at commit \`${SRC}\`.

- Widget demo: https://anonymusk7.github.io/showup-demo/widget/demo.html
- Host dashboard: https://anonymusk7.github.io/showup-demo/dashboard/
- Door check-in: https://anonymusk7.github.io/showup-demo/dashboard/checkin.html

Testnet only. No relayer runs here, so cancel and check-in are signed by your wallet. Source, tests and the gasless relayer are in the main repo.
The \`widget/vendor/*.js\` files are minified third-party bundles (Wallet Selector, qrcode, @noble), see the main repo's README. MIT licensed.
`);
console.log('built', OUT);
