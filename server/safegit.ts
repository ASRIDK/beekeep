// Git run by Beekeep itself. A folder's git settings can name programs for git to
// start, and bees can write in those folders. So this git runs in a macOS sandbox
// where it can start nothing but git, reach no network, and write only where told.
import { execFile, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';

let found: { git: string; parts: string } | null = null;

function where(): { git: string; parts: string } {
  if (found) return found;
  // /usr/bin/git only hands over to the real one, which the sandbox must name.
  const git = realpathSync(execFileSync('/usr/bin/xcrun', ['-f', 'git'], { encoding: 'utf8' }).trim());
  const parts = realpathSync(execFileSync(git, ['--exec-path'], { encoding: 'utf8' }).trim());
  found = { git, parts };
  return found;
}

const text = (p: string) => {
  if (/["\\\u0000-\u001f]/.test(p)) throw new Error(`Beekeep cannot use git in a folder with such a name: ${p}`);
  return `"${p}"`;
};

export interface GitCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** How to call git in a folder. It may write only below the given places. */
export function gitCall(folder: string, args: string[], writable: string[] = []): GitCall {
  const { git, parts } = where();
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny process-exec*)',
    `(allow process-exec* (literal ${text(git)}) (subpath ${text(parts)}))`,
    '(deny file-write*)',
    `(allow file-write* (literal "/dev/null") ${writable.map((w) => `(subpath ${text(w)})`).join(' ')})`,
  ].join('\n');
  const quiet = [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0',
    '-c', 'filter.lfs.required=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=',
  ];
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, git, ...quiet, '-C', folder, ...args],
    env: {
      PATH: `${dirname(git)}:/usr/bin:/bin`,
      HOME: process.env.HOME,
      LANG: 'en_US.UTF-8',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  };
}

/** Runs git and gives what it printed. Takes as long as it takes, without holding up the rest of Beekeep. */
export function git(folder: string, args: string[], writable: string[] = [], timeout = 20_000): Promise<string> {
  const c = gitCall(folder, args, writable);
  return new Promise((done, fail) => {
    const child = execFile(c.command, c.args, { env: c.env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, out, said) => {
      if (!err) return done(out.trim());
      const why = err.killed ? 'it took too long.' : said.trim().split('\n').at(-1) || 'no reason given';
      fail(new Error(why));
    });
    child.stdin?.end();
  });
}
