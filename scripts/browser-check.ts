// Checks, with a real browser and no Claude, that a hostile page cannot change how
// it is read. Run: node scripts/browser-check.ts
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hive-browser-')));
process.env.BEEKEEP_HOME = dir;
const { Browsers } = await import('../server/browser.ts');

const PAGE = `<!doctype html><title>Shop</title><h1>Shop</h1><button onclick="this.textContent='Bought'">Buy</button><a href="/next">Next</a>
<script>
  const real = Array.prototype.push;
  Array.prototype.push = function (...a) { for (let i = 0; i < 9999; i++) real.apply(this, a); return this.length; };
  Array.prototype.slice = function () { return ['forged']; };
  Document.prototype.querySelectorAll = () => [];
</script>`;
const server = createServer((_, res) => res.setHeader('content-type', 'text/html').end(PAGE)).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const { port } = server.address() as AddressInfo;

let bad = 0;
const check = (name: string, ok: boolean, extra: unknown = '') => {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, ok ? '' : extra);
};
const browsers = new Browsers();
const first = await browsers.beeOpen('b', 'main', `http://127.0.0.1:${port}/`);
check('a page is read as it is, whatever its scripts do', first.includes('[1] button "Buy"') && first.includes('[2] a "Next"') && first.includes('h1: Shop') && !first.includes('[3]'), first);
check('only the numbers it was given count', browsers.sees('b', 2) && !browsers.sees('b', 3) && !browsers.sees('b', 151));
const second = await browsers.beeClick('b', 1);
check('a click lands, and the next look has new numbers', second.includes('[151] button "Bought"') && !browsers.sees('b', 1), second);
const third = await browsers.beeClick('b', 152);
check('reading works again on the next page', third.includes('/next') && third.includes('button "Buy"'), third);
await browsers.shutdown();
server.close();
rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
process.exit(bad ? 1 : 0);
