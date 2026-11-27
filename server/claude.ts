import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Finds the person's own Claude Code, so bees use its login and version. */
export function findClaude(): string {
  const found = findTool('claude', process.env.BEEKEEP_CLAUDE);
  if (found) return found;
  throw new Error('Claude Code was not found. Install it, then run `claude auth login`.');
}

/** Finds the person's own Codex, if they have it. */
export function findCodex(): string | null {
  return findTool('codex', process.env.BEEKEEP_CODEX);
}

/** A program the person installed, from their settings, the usual places, or the path. */
export function findTool(name: string, chosen?: string): string | null {
  const places = [
    chosen,
    join(homedir(), '.local/bin', name),
    ...(process.env.PATH ?? '').split(delimiter).map((d) => join(d, name)),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
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
  return null;
}
