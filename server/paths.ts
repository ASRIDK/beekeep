import { lstatSync, mkdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function hiveHome(): string {
  return process.env.BEEKEEP_HOME ?? join(homedir(), '.beekeep');
}

export function defaultWorkspace(): string {
  return process.env.BEEKEEP_WORK ?? join(homedir(), 'beekeep-work');
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Real location of a path, following links even when the last part does not
 * exist yet. A link pointing at a missing file still resolves to its target, so
 * writing "through" it cannot leave the workspace unnoticed.
 */
export function realLocation(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (let hops = 0; hops < 64; ) {
    try {
      return join(realpathSync.native(current), ...tail.toReversed());
    } catch {
      let isLink = false;
      try {
        isLink = lstatSync(current).isSymbolicLink();
      } catch {
        // Missing entirely: step up to the parent below.
      }
      if (isLink) {
        hops += 1;
        current = resolve(dirname(current), readlinkSync(current));
        continue;
      }
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail.toReversed());
      tail.push(basename(current));
      current = parent;
    }
  }
  throw new Error(`Too many links in path: ${p}`);
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(realLocation(root), realLocation(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** Checks and creates a folder a bee may work in. Returns its real path. */
export function prepareWorkspace(raw: string): string {
  const wanted = expandHome(raw.trim());
  if (!isAbsolute(wanted)) throw new Error('Workspace must be a full path, for example ~/beekeep-work.');
  const real = realLocation(wanted);
  const segments = real.split(sep).map((s) => s.toLowerCase());
  if (segments.includes('.claude')) throw new Error('Workspace cannot be inside a .claude folder.');
  if (segments.includes('.ssh')) throw new Error('Workspace cannot be inside a .ssh folder.');
  if (isInside(real, homedir())) throw new Error('Workspace is too broad: pick a folder inside your home.');
  if (isInside(hiveHome(), real)) throw new Error("Workspace cannot be inside Beekeep's own data folder.");
  mkdirSync(real, { recursive: true });
  return real;
}
