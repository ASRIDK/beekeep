// node-pty ships its macOS spawn-helper without the executable bit, which makes
// every terminal fail with "posix_spawnp failed". Restore it after each install.
// node-pty is found the way Node finds it, because npm may hoist it out of
// beekeep's own folder (npx, or beekeep installed inside a project).
import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let root;
try {
  root = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
} catch {
  process.exit(0);
}
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(root, 'prebuilds', arch, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
