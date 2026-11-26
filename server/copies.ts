// A bee's own git copy of a project: a complete, separate repository with its own
// branch. Nothing a bee does there can touch the person's repository; the person
// brings work over when they want it. Copies are never deleted by Beekeep.
import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { git, SAFE_GIT } from './safegit.ts';

/** For work that grows with the size of a project. */
const LONG = 10 * 60_000;

export interface Copy {
  /** The whole copy. */
  root: string;
  /** Where the bee works. */
  path: string;
  branch: string;
  /** The commit it started from. */
  base: string;
}

export interface CopyState {
  branch: string;
  /** Commits made in the copy since it started. */
  commits: number;
  changes: number;
  path: string;
  origin: string;
}

const copiesHome = () => process.env.BEEKEEP_COPIES ?? join(homedir(), 'beekeep-copies');

/** The repository folder of a path inside a copy, or null if it is not one Beekeep made. */
export function copyRoot(path: string): string | null {
  if (!existsSync(copiesHome())) return null;
  const home = realpathSync(copiesHome());
  const name = relative(home, path).split(sep)[0];
  return name && name !== '..' && path.startsWith(home + sep) ? join(home, name) : null;
}

export async function makeCopy(folder: string, name: string, id: string): Promise<Copy> {
  if (!SAFE_GIT) throw new Error('Own git copies need macOS for now.');
  let top: string;
  try {
    top = realpathSync(await git(folder, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new Error('This folder is not in a git project, so there is nothing to make a copy of.');
  }
  try {
    await git(top, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    throw new Error('This git project has no commits yet. Commit once, then turn this on.');
  }
  mkdirSync(copiesHome(), { recursive: true });
  const home = realpathSync(copiesHome());
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bee';
  const tag = claim(home, basename(top), `${slug}-${id.slice(0, 4)}`);
  const root = join(home, `${basename(top)}-${tag}`);
  const branch = `hive/${tag}`;
  try {
    const base = await throughFile('Git could not make the copy', async (file, dir) => {
      await git(top, ['bundle', 'create', '--quiet', file, 'HEAD'], [dir], LONG);
      await git(root, ['init', '--quiet', '--template='], [root]);
      const ends = shallowEnds(await git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']));
      if (ends) writeFileSync(join(root, '.git/shallow'), ends, { flag: 'wx' });
      await git(root, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', file, `HEAD:refs/heads/${branch}`], [root], LONG);
      await git(root, ['checkout', '--quiet', branch, '--'], [root], LONG);
      return git(root, ['rev-parse', branch]);
    });
    const path = join(root, relative(top, realpathSync(folder)));
    mkdirSync(path, { recursive: true });
    return { root, path, branch, base };
  } catch (err) {
    dropUnused(root);
    throw err;
  }
}

/** Takes a folder name nobody else has, and returns the part that makes it different. */
function claim(home: string, project: string, wanted: string): string {
  for (let n = 1; ; n++) {
    const tag = n === 1 ? wanted : `${wanted}-${n}`;
    try {
      mkdirSync(join(home, `${project}-${tag}`));
      return tag;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** Only for a copy that was made moments ago and that no bee has worked in. */
export function dropUnused(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Where a shortened history ends. A bee may have put something else there, so only commit ids pass. */
export function shallowEnds(path: string): string {
  let file: number;
  try {
    file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error('its list of shortened history is not a plain file.');
  }
  try {
    const text = fstatSync(file).isFile() ? readFileSync(file, 'utf8') : 'not a file';
    if (!/^(([0-9a-f]{40}|[0-9a-f]{64})\n)*$/.test(text)) throw new Error('its list of shortened history is damaged.');
    return text;
  } finally {
    closeSync(file);
  }
}

/** Passes history on in a file, so neither repository ever reaches into the other. */
async function throughFile<T>(problem: string, work: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hive-git-')));
  try {
    return await work(join(dir, 'history.bundle'), dir);
  } catch (err) {
    throw new Error(`${problem}: ${(err as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function copyState(path: string, origin: string, branch: string, base: string): Promise<CopyState | null> {
  try {
    const [list, commits] = await Promise.all([
      git(path, ['status', '--porcelain', '--untracked-files=all']),
      git(path, ['rev-list', '--count', 'HEAD', `^${base}`]),
    ]);
    return { branch, commits: Number(commits), changes: list.split('\n').filter(Boolean).length, path, origin };
  } catch {
    return null;
  }
}

/**
 * Brings the bee's commits into the person's repository, as a branch of the same
 * name. Nothing is merged and no file of the person changes.
 */
export async function bringCopy(path: string, origin: string, branch: string, base: string): Promise<string> {
  const commits = await git(path, ['rev-list', '--count', branch, `^${base}`]);
  if (commits === '0') throw new Error('There are no new commits to bring in. Uncommitted work stays in the copy.');
  return throughFile('Git could not bring it in', async (file, dir) => {
    await git(path, ['bundle', 'create', '--quiet', file, branch, `^${base}`], [dir], LONG);
    const common = realpathSync(await git(origin, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const into = `refs/heads/${branch}:refs/heads/${branch}`;
    await git(origin, ['-c', 'fetch.fsckObjects=true', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', file, into], [common], LONG);
    return commits;
  });
}
