import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyRoot, copyState, makeCopy, shallowEnds } from '../server/copies.ts';
import { sandboxFor } from '../server/driver.ts';
import { Hive } from '../server/hive.ts';
import { git as safeGit } from '../server/safegit.ts';
import { Spaces } from '../server/spaces.ts';
import { Store } from '../server/store.ts';
import { NO_ABILITIES } from '../server/types.ts';

let dir: string;
let repo: string;
let store: Store;
let hive: Hive;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', file);
};
const withCopy = (workspace = repo, name = 'Anna B.') => hive.withCopy({ name, mode: 'work', workspace, abilities: { ...NO_ABILITIES, shell: true } });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hive-')));
  process.env.BEEKEEP_COPIES = join(dir, 'copies');
  repo = join(dir, 'shop');
  mkdirSync(join(repo, 'web'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'web/a.txt', 'one');
  store = new Store(join(dir, 'hive.db'));
  hive = new Hive({ store, start: async () => ({ send: () => {}, interrupt: async () => {}, close: () => {} }) });
});

afterEach(() => {
  hive.shutdown();
  store.close();
});

describe('a bee’s own copy', () => {
  it('is a separate repository, and leaves the person’s files alone', async () => {
    const b = await withCopy(join(repo, 'web'));
    expect(b.origin).toBe(join(repo, 'web'));
    expect(b.branch).toMatch(/^hive\/anna-b-/);
    expect(b.workspace.endsWith('/web')).toBe(true);
    expect(git(b.workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(b.branch);
    expect(git(b.workspace, 'remote')).toBe('');
    commit(b.workspace, 'a.txt', 'two');
    writeFileSync(join(b.workspace, 'b.txt'), 'x');
    expect(await hive.copy(b.id)).toMatchObject({ branch: b.branch, commits: 1, changes: 1 });
    expect(readFileSync(join(repo, 'web/a.txt'), 'utf8')).toBe('one');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'branch', '--list', 'hive/*')).toBe('');
  });

  it('shares nothing: destroying the copy does not harm the repository', async () => {
    const b = await withCopy();
    const inodes = (p: string) => new Set(execFileSync('/usr/bin/find', [p, '-type', 'f', '-exec', '/usr/bin/stat', '-f', '%i', '{}', '+'], { encoding: 'utf8' }).split('\n').filter(Boolean));
    const mine = inodes(join(repo, '.git'));
    for (const i of inodes(join(b.workspace, '.git'))) expect(mine.has(i)).toBe(false);
    expect(existsSync(join(b.workspace, '.git/objects/info/alternates'))).toBe(false);
  });

  it('is brought in as a branch, only when the person asks, and only new work', async () => {
    const b = await withCopy();
    await expect(hive.bring(b.id)).rejects.toThrow(/no new commits/);
    commit(b.workspace, 'new.txt', 'hello');
    expect(await hive.bring(b.id)).toBe('1');
    expect(git(repo, 'show', `${b.branch}:new.txt`)).toBe('hello');
    expect(existsSync(join(repo, 'new.txt'))).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    commit(b.workspace, 'more.txt', 'x');
    expect(await hive.bring(b.id)).toBe('2');
    git(repo, 'merge', '-q', b.branch!);
    expect(readFileSync(join(repo, 'more.txt'), 'utf8')).toBe('x');
    // History the bee rewrote does not silently replace what the person has.
    const before = git(repo, 'rev-parse', b.branch!);
    git(b.workspace, 'commit', '-q', '--amend', '-m', 'rewritten');
    await expect(hive.bring(b.id)).rejects.toThrow(/could not bring it in/);
    expect(git(repo, 'rev-parse', b.branch!)).toBe(before);
  });

  it('works for a repository whose current commit is on no branch', async () => {
    git(repo, 'checkout', '-q', '--detach');
    commit(repo, 'loose.txt', 'loose');
    const b = await withCopy();
    expect(readFileSync(join(b.workspace, 'loose.txt'), 'utf8')).toBe('loose');
    commit(b.workspace, 'x.txt', 'x');
    expect(await hive.bring(b.id)).toBe('1');
  });

  it('works for a repository with only recent history', async () => {
    commit(repo, 'second.txt', '2');
    const shallow = join(dir, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, shallow]);
    const b = await withCopy(shallow);
    commit(b.workspace, 'x.txt', 'x');
    expect(await hive.bring(b.id)).toBe('1');
    expect(git(shallow, 'show', `${b.branch}:x.txt`)).toBe('x');
  });

  it('copies nothing but commit ids from the list of shortened history', async () => {
    const secret = join(dir, 'secret');
    writeFileSync(secret, 'token-123\n');
    const list = join(repo, '.git/shallow');
    symlinkSync(secret, list);
    await expect(makeCopy(repo, 'A', 'abcd1234')).rejects.toThrow(/could not make the copy/);
    unlinkSync(list);
    writeFileSync(list, 'token-123\n');
    await expect(makeCopy(repo, 'A', 'abcd1234')).rejects.toThrow();
    expect(readdirSync(join(dir, 'copies'))).toEqual([]);

    // Git refuses these by itself, unless they are swapped in at the right moment.
    const id = 'a'.repeat(40);
    expect(() => shallowEnds(list)).toThrow(/damaged/);
    writeFileSync(list, `${id}\ntoken-123\n`);
    expect(() => shallowEnds(list)).toThrow(/damaged/);
    writeFileSync(list, `${id}\n`);
    expect(shallowEnds(list)).toBe(`${id}\n`);
    symlinkSync(list, join(dir, 'link'));
    expect(() => shallowEnds(join(dir, 'link'))).toThrow(/not a plain file/);
    execFileSync('/usr/bin/mkfifo', [join(dir, 'pipe')]);
    expect(() => shallowEnds(join(dir, 'pipe'))).toThrow();
    expect(shallowEnds(join(dir, 'missing'))).toBe('');
  });

  it('lets Beekeep’s own git write only where told', async () => {
    await expect(safeGit(repo, ['branch', 'made'])).rejects.toThrow(/not permitted/i);
    expect(git(repo, 'branch', '--list', 'made')).toBe('');
    await safeGit(repo, ['branch', 'made'], [join(repo, '.git')]);
    expect(git(repo, 'branch', '--list', 'made')).toBe('made');
  });

  it('does not hold up the rest of Beekeep, even when git waits forever', async () => {
    // A pipe nobody writes to, where git expects a file.
    execFileSync('/usr/bin/mkfifo', [join(repo, '.git/shallow')]);
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    await expect(safeGit(repo, ['status'], [], 600)).rejects.toThrow(/too long/);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(10);
  });

  it('holds a bee’s orders until its copy is ready', async () => {
    const seen: string[] = [];
    hive.shutdown();
    hive = new Hive({ store, start: async (b) => ({ send: () => void seen.push(b.workspace), interrupt: async () => {}, close: () => {} }) });
    const b = hive.createBee({ name: 'Anna', mode: 'work', workspace: repo });
    const copying = hive.withCopy({}, b.id);
    hive.order(b.id, 'change something');
    await expect(hive.withCopy({}, b.id)).rejects.toThrow(/already/);
    expect(seen).toEqual([]);
    const { workspace } = await copying;
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([workspace]);
    expect(workspace).not.toBe(repo);
  });

  it('can be given to two bees at once, and to a bee that exists', async () => {
    const [a, b] = await Promise.all([withCopy(repo, 'One'), withCopy(repo, 'Two')]);
    expect(a!.workspace).not.toBe(b!.workspace);
    const c = hive.createBee({ name: 'Three', mode: 'work', workspace: repo });
    const given = await hive.withCopy({ role: 'tester' }, c.id);
    expect(given).toMatchObject({ id: c.id, role: 'tester', origin: repo });
    expect((await hive.withCopy({ role: 'again' }, c.id)).workspace).toBe(given.workspace);
    // A copy made for nothing is not left lying around.
    const before = readdirSync(join(dir, 'copies')).length;
    const racing = withCopy(repo, 'Four');
    hive.createBee({ name: 'Four', workspace: repo });
    await expect(racing).rejects.toThrow(/already a bee called/);
    expect(readdirSync(join(dir, 'copies'))).toHaveLength(before);
  });

  it('is never deleted, whatever state it is in', async () => {
    const b = await withCopy();
    commit(b.workspace, 'x.txt', 'x');
    git(b.workspace, 'checkout', '-q', '--detach');
    commit(b.workspace, 'y.txt', 'y');
    expect(hive.removeBee(b.id)).toContain(b.workspace);
    expect(readFileSync(join(b.workspace, 'y.txt'), 'utf8')).toBe('y');
    // A later copy neither reuses the folder nor the branch.
    const again = await makeCopy(repo, 'Anna B.', b.id);
    expect(again.path).not.toBe(b.workspace);
    expect(again.branch).not.toBe(b.branch);
  });

  it('can be given up, and the bee goes back to the folder', async () => {
    const b = await withCopy();
    expect(hive.updateBee(b.id, { workspace: '/ignored-while-in-a-copy' }).workspace).toBe(b.workspace);
    hive.leaveCopy(b.id);
    expect(hive.view(b.id)).toMatchObject({ workspace: repo, origin: null, branch: null });
    expect(existsSync(b.workspace)).toBe(true);
    await expect(hive.bring(b.id)).rejects.toThrow(/no copy/);
  });

  it('explains folders that cannot be copied, and leaves nothing half made', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    await expect(makeCopy(plain, 'A', 'abcd1234')).rejects.toThrow(/not in a git project/);
    const empty = join(dir, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q');
    await expect(makeCopy(empty, 'A', 'abcd1234')).rejects.toThrow(/no commits/);
    const broken = join(dir, 'broken');
    mkdirSync(broken);
    git(broken, 'init', '-q');
    commit(broken, 'a.txt', 'x');
    const blob = git(broken, 'rev-parse', 'HEAD:a.txt');
    renameSync(join(broken, '.git/objects', blob.slice(0, 2)), join(dir, 'gone'));
    await expect(makeCopy(broken, 'A', 'abcd1234')).rejects.toThrow(/could not make the copy/);
    expect(existsSync(join(dir, 'copies')) ? readdirSync(join(dir, 'copies')) : []).toEqual([]);
    expect(await copyState(plain, plain, 'x', 'y')).toBeNull();
  });

  it('leaves nothing behind when the files themselves cannot be laid out', async () => {
    // Some projects need a program to unpack their files, which Beekeep's git may not start.
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      writeFileSync(join(dir, '.gitconfig'), '[filter "x"]\n\tclean = /bin/cat\n\tsmudge = /bin/cat\n\trequired = true\n');
      commit(repo, '.gitattributes', '*.txt filter=x\n');
      await expect(makeCopy(repo, 'A', 'abcd1234')).rejects.toThrow(/could not make the copy/);
      expect(readdirSync(join(dir, 'copies'))).toEqual([]);
    } finally {
      process.env.HOME = home;
    }
  });

  it('does not run the project’s hooks', async () => {
    const mark = join(dir, 'hook-ran');
    for (const name of ['post-checkout', 'reference-transaction', 'post-merge']) {
      writeFileSync(join(repo, '.git/hooks', name), `#!/bin/sh\ntouch ${mark}\n`);
      chmodSync(join(repo, '.git/hooks', name), 0o755);
    }
    const b = await withCopy();
    commit(b.workspace, 'x.txt', 'x');
    await hive.bring(b.id);
    expect(existsSync(mark)).toBe(false);
  });

  it('gives a confined bee its own git folder at most, and never hooks or settings', async () => {
    const top = await withCopy();
    const root = copyRoot(top.workspace)!;
    expect(root).toBe(top.workspace);
    expect(sandboxFor(top)!.filesystem!.allowWrite).toBeUndefined();
    expect(sandboxFor(top)!.filesystem!.denyWrite).toEqual(expect.arrayContaining([join(root, '.git/hooks'), join(root, '.git/config')]));

    const sub = await withCopy(join(repo, 'web'), 'Sub');
    const own = join(copyRoot(sub.workspace)!, '.git');
    expect(sandboxFor(sub)!.filesystem!.allowWrite).toEqual([own]);
    // Swapped for a link into the person's repository, it is not granted.
    renameSync(own, `${own}-old`);
    symlinkSync(join(repo, '.git'), own);
    expect(sandboxFor(sub)!.filesystem!.allowWrite).toBeUndefined();
  });

  it('still lets a confined bee commit, under the same rules as macOS applies them', async () => {
    for (const b of [await withCopy(), await withCopy(join(repo, 'web'), 'Sub')]) {
      const { allowWrite = [], denyWrite = [] } = sandboxFor(b)!.filesystem!;
      const paths = (list: string[]) => list.map((p) => `(subpath "${p}")`).join(' ');
      const profile = `(version 1)(allow default)(deny file-write*)(allow file-write* (literal "/dev/null") ${paths([b.workspace, ...allowWrite])})(deny file-write* ${paths(denyWrite)})`;
      const run = (script: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', script], { cwd: b.workspace, encoding: 'utf8' });
      const done = run('echo x > new.txt && git add -A && git -c user.name=t -c user.email=t@t commit -q -m ok');
      expect(done.stderr).toBe('');
      expect(git(b.workspace, 'log', '-1', '--format=%s')).toBe('ok');
      const top = join(copyRoot(b.workspace)!, '.git');
      for (const plant of ['commondir', 'config', 'config.worktree', 'hooks', 'info', 'modules', 'worktrees']) {
        expect(run(`echo x >> ${top}/${plant}`).status, plant).not.toBe(0);
        expect(run(`mkdir -p ${top}/${plant}/a && echo x > ${top}/${plant}/a/b`).status, plant).not.toBe(0);
      }
      expect(run(`echo x > ${repo}/a.txt || git -C ${repo} branch planted`).status).not.toBe(0);
    }
  });

  it('is recognised only where Beekeep makes copies', async () => {
    const b = await withCopy(join(repo, 'web'));
    expect(copyRoot(b.workspace)).toBe(join(b.workspace, '..'));
    expect(copyRoot(repo)).toBeNull();
    expect(copyRoot(join(dir, 'copies'))).toBeNull();
  });

  it('never lets planted git settings start a program', async () => {
    const mark = join(dir, 'planted');
    const b = await withCopy();
    const prog = join(dir, 'evil.sh');
    // It also sends a signal, which no limit on writing would hide.
    writeFileSync(prog, `#!/bin/sh\nkill -USR2 ${process.pid}\ntouch ${mark}\ncat\n`);
    let signals = 0;
    const heard = () => void (signals += 1);
    process.on('SIGUSR2', heard);
    chmodSync(prog, 0o755);
    // What an approved command could leave behind in a folder.
    for (const place of [repo, b.workspace]) {
      git(place, 'config', 'filter.x.clean', prog);
      git(place, 'config', 'core.fsmonitor', prog);
      git(place, 'config', 'uploadpack.packObjectsHook', prog);
    }
    writeFileSync(join(b.workspace, '.gitattributes'), '* filter=x\n');
    writeFileSync(join(b.workspace, 'web/a.txt'), 'changed');
    expect(await hive.copy(b.id)).not.toBeUndefined();
    const spaces = new Spaces(store, () => []);
    const s = spaces.create('S', b.workspace);
    await spaces.refresh();
    await makeCopy(repo, 'Other', 'ffff0000');
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(mark)).toBe(false);
    expect(signals).toBe(0);
    expect(spaces.info()[s.id]).toBeDefined();
    // The same settings do run with ordinary git, so this test means something.
    try {
      git(b.workspace, 'status');
    } catch {
      // The planted program is broken as a filter; only its side effect matters.
    }
    await new Promise((r) => setTimeout(r, 50));
    process.off('SIGUSR2', heard);
    expect(existsSync(mark)).toBe(true);
    expect(signals).toBeGreaterThan(0);
  });
});
