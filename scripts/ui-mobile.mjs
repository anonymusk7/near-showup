// Headless-Chromium mobile layout check for the widget, dashboard and door page (360/390/414 px) in three modes:
// live, rpc-down (testnet RPC requests aborted) and 1click-down (quote proxy answers 502). Exit 1 on any problem.
// Needs a running `pnpm serve` and playwright-core, which is not a repo dependency:
//   npm i --no-save playwright-core && CHROME=/path/to/chrome node scripts/ui-mobile.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { try { ({ chromium } = createRequire(import.meta.url)('playwright-core')); } catch {} } // require honours NODE_PATH, import() does not
if (!chromium) { console.error('playwright-core not found: npm i --no-save playwright-core (or set NODE_PATH) and set CHROME=/path/to/chrome'); process.exit(2); }

const BASE = process.env.BASE || 'http://localhost:8080', OUT = process.env.OUT || '/tmp/showup-shots';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const FACTORY = 'showup-factory-1793597558.testnet';
const MODES = (process.env.MODES || 'live,rpc-down,1click-down').split(',');
const WIDTHS = (process.env.WIDTHS || '360,390,414').split(',').map(Number);
const RPC_DOWN = "Can't reach NEAR testnet", QUOTE_DOWN = '1Click quotes are unavailable';
// [name, path, text expected in rpc-down mode, text expected in 1click-down mode]
const PAGES = [
  ['widget', '/widget/demo.html', RPC_DOWN, QUOTE_DOWN],
  ['dash-settled', '/dashboard/?event=showup-demo-1793595312.testnet', RPC_DOWN],
  ['dash-gasless', `/dashboard/?event=gasless-1793775606.${FACTORY}`, RPC_DOWN],
  ['dash-empty', '/dashboard/'],
  ['checkin', `/dashboard/checkin.html?event=judges-2026.${FACTORY}`, RPC_DOWN],
];
mkdirSync(OUT, { recursive: true });

// Page-side: viewport overflow (incl. elements inside open shadow roots) and all visible text (incl. shadow roots).
function inspect() {
  const vw = document.documentElement.clientWidth, over = [], text = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      const b = el.getBoundingClientRect();
      if (b.width && (b.right > vw + 1 || b.left < -1) && getComputedStyle(el).position !== 'fixed')
        over.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().replace(/\s+/g, '.') : ''} [${Math.round(b.left)},${Math.round(b.right)}]`);
      if (el.shadowRoot) { walk(el.shadowRoot); text.push(...[...el.shadowRoot.children].filter((c) => c.tagName !== 'STYLE').map((c) => c.innerText)); }
    }
  };
  walk(document);
  return { vw, sw: document.documentElement.scrollWidth, over: over.slice(0, 8), text: [document.body.innerText, ...text].join(' ').replace(/\s+/g, ' ') };
}
const textHas = (needle) => { // runs in the page; same text collection as inspect()
  const parts = [document.body.innerText], walk = (r) => r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) { parts.push(el.shadowRoot.textContent); walk(el.shadowRoot); } });
  walk(document); return parts.join(' ').includes(needle);
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const problems = [];
async function check(label, w, setup, act) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await setup?.(page);
    const expect = await act(page);
    const r = await page.evaluate(inspect);
    await page.screenshot({ path: `${OUT}/${label.replace(/\W+/g, '-')}-${w}.png`, fullPage: true });
    const missing = (expect || []).filter((t) => !r.text.includes(t));
    const bad = [r.sw > r.vw && `scrollWidth ${r.sw} > ${r.vw}`, r.over.length && `past edge: ${r.over.join(', ')}`,
      errors.length && `page errors: ${errors.join(' | ')}`, missing.length && `missing text: ${missing.map((t) => JSON.stringify(t)).join(', ')}`].filter(Boolean);
    console.log(`${bad.length ? 'FAIL' : 'ok  '} ${label} @${w}${bad.length ? ': ' + bad.join('; ') : ''}`);
    if (process.env.TEXT) console.log('   text:', r.text.slice(0, 900));
    if (bad.length) problems.push(`${label} @${w}`);
  } catch (e) { console.log(`FAIL ${label} @${w}: ${e.message.split('\n')[0]}`); problems.push(`${label} @${w}`); }
  await ctx.close();
}

for (const mode of MODES) for (const w of WIDTHS) for (const [name, path, rpcText, quoteText] of PAGES) {
  const expect = mode === 'rpc-down' ? rpcText : mode === '1click-down' ? quoteText : null;
  await check(`${mode} ${name}`, w, async (page) => {
    if (mode === 'rpc-down') await page.route(/rpc\.testnet\.(near\.org|fastnear\.com)/, (r) => r.abort('failed'));
    if (mode === '1click-down') await page.route(/\/api\/1click\//, (r) => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"1Click unavailable (HTTP 521)"}' }));
  }, async (page) => {
    await page.goto(BASE + path, { waitUntil: 'load' });
    if (expect) await page.waitForFunction(textHas, expect, { timeout: 25000 }).catch(() => {}); // reported as missing text below
    await page.waitForTimeout(expect ? 1000 : 7000); // let live RPC/quote calls settle the layout
    return expect ? [expect] : [];
  });
}

// Sign-in: a signed-out visitor taps the widget's main button and gets the wallet selector, which must fit at 375 px.
await check('signin wallet-modal', 375, null, async (page) => {
  await page.goto(BASE + '/widget/demo.html', { waitUntil: 'load' });
  const btn = page.locator('button.rsvp').first(); // CSS locators pierce open shadow roots
  await btn.waitFor({ timeout: 25000 });
  if (await btn.isDisabled()) throw new Error(`first widget's button is disabled ("${await btn.innerText()}"): its event is not open`);
  await btn.click();
  await page.getByText('MyNearWallet').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  return ['MyNearWallet', 'Meteor'];
});

await browser.close();
console.log(`\n${problems.length ? `PROBLEMS (${problems.length}): ${problems.join(', ')}` : 'ALL OK'} · screenshots in ${OUT}`);
process.exit(problems.length ? 1 : 0);
