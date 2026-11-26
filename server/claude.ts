import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Finds the person's own Claude Code, so bees use its login and version. */
export function findClaude(): string {
  const places = [
    process.env.BEEKEEP_CLAUDE,
    join(homedir(), '.local/bin/claude'),
    ...(process.env.PATH ?? '').split(delimiter).map((d) => join(d, 'claude')),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const p of places) {
    if (!p) continue;
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // Not here; try the next place.
    }
  }
  throw new Error('Claude Code was not found. Install it, then run `claude auth login`.');
}
