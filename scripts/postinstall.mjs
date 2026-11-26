// node-pty ships its macOS spawn-helper without the executable bit, which makes
// every terminal fail with "posix_spawnp failed". Restore it after each install.
import { chmodSync, existsSync } from 'node:fs';

for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = new URL(`../node_modules/node-pty/prebuilds/${arch}/spawn-helper`, import.meta.url);
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
