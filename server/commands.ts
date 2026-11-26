import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from './paths.ts';
import type { Store } from './store.ts';
import type { Command, SpaceRow } from './types.ts';

const MAX_BYTES = 64 * 1024;

/**
 * Commands a project offers in its hive.json:
 *   { "commands": [{ "name": "Dev server", "run": "npm run dev" }] }
 * A file that came with a project must not run anything until the person has
 * seen it and said yes, and again after it changes.
 */
export class Commands {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private load(space: SpaceRow): { file: string; hash: string; commands: { name: string; run: string }[] } | null {
    const file = join(expandHome(space.folder), 'hive.json');
    try {
      if (statSync(file).size > MAX_BYTES) return null;
      const text = readFileSync(file, 'utf8');
      const raw = (JSON.parse(text) as { commands?: unknown }).commands;
      const commands = (Array.isArray(raw) ? raw : [])
        .filter((c): c is { name: string; run: string } => typeof c?.name === 'string' && typeof c?.run === 'string')
        // One line each, so what is shown is exactly what is typed.
        .filter((c) => !/[\u0000-\u001f\u007f]/.test(c.run + c.name))
        .slice(0, 50)
        .map((c) => ({ name: c.name.slice(0, 80), run: c.run.slice(0, 2000) }));
      return { file, hash: createHash('sha256').update(text).digest('hex'), commands };
    } catch {
      return null;
    }
  }

  list(space: SpaceRow): Command[] {
    const found = this.load(space);
    if (!found) return [];
    const trusted = this.store.get(`trust:${found.file}`) === found.hash;
    return found.commands.map((c) => ({ ...c, space: space.id, file: found.file, trusted }));
  }

  trust(space: SpaceRow): void {
    const found = this.load(space);
    if (found) this.store.set(`trust:${found.file}`, found.hash);
  }

  /** The text to type, if the person has said yes to this exact file. */
  text(space: SpaceRow, name: string): string {
    const c = this.list(space).find((x) => x.name === name);
    if (!c) throw new Error(`No command called "${name}" here.`);
    if (!c.trusted) throw new Error('Look at this project’s commands and allow them first.');
    return c.run;
  }
}
