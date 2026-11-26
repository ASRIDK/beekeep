import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { beeEnv, loginOf, sandboxFor } from '../server/driver.ts';
import { hiveHome, isInside, prepareWorkspace } from '../server/paths.ts';
import { grantFor, judge, toolsFor } from '../server/policy.ts';
import { type BeeRow, NO_ABILITIES } from '../server/types.ts';

let root: string;
let ws: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-')));
  ws = join(root, 'ws');
  mkdirSync(ws);
});

const bare = () => ({ workspace: ws, confined: true, abilities: NO_ABILITIES, grants: [] as { tool: string; match?: string }[] });
const work = () => ({ mode: 'work' as const, ...bare() });
const look = () => ({ mode: 'look' as const, ...bare() });
const full = () => ({ mode: 'full' as const, ...bare() });

describe('file access', () => {
  it('allows reading and changing files inside the workspace', () => {
    expect(judge(work(), 'Write', { file_path: join(ws, 'a/b.txt') }).kind).toBe('allow');
    expect(judge(work(), 'Edit', { file_path: 'a.txt' }).kind).toBe('allow');
    expect(judge(look(), 'Read', { file_path: join(ws, 'a.txt') }).kind).toBe('allow');
  });

  it.each([
    ['full path outside', '/etc/hosts'],
    ['climbing out', '../secret.txt'],
    ['climbing out deeper', 'a/../../secret.txt'],
    ['home shortcut', '~/.ssh/id_rsa'],
    ['sibling with the same prefix', '../ws-evil/x'],
    ['missing path', undefined],
  ])('asks before leaving the workspace: %s', (_, file_path) => {
    expect(judge(work(), 'Write', { file_path }).kind).toBe('ask');
    expect(judge(work(), 'Read', { file_path }).kind).toBe('ask');
  });

  it('asks when a link inside the workspace points out of it', () => {
    mkdirSync(join(root, 'out'));
    writeFileSync(join(root, 'out/f.txt'), 'x');
    symlinkSync(join(root, 'out'), join(ws, 'dir'));
    symlinkSync(join(root, 'out/f.txt'), join(ws, 'file'));
    symlinkSync(join(root, 'out/not-yet.txt'), join(ws, 'dangling'));
    symlinkSync('../out/not-yet.txt', join(ws, 'dangling-relative'));
    for (const p of ['dir/new.txt', 'file', 'dangling', 'dangling-relative']) {
      expect(judge(work(), 'Write', { file_path: p }).kind, p).toBe('ask');
    }
  });

  it('does not hang on links that point at each other', () => {
    symlinkSync(join(ws, 'b'), join(ws, 'a'));
    symlinkSync(join(ws, 'a'), join(ws, 'b'));
    expect(judge(work(), 'Write', { file_path: 'a' }).kind).toBe('ask');
  });

  it('asks before changing files other programs trust, even inside', () => {
    for (const p of ['.git/hooks/pre-commit', '.claude/settings.json', '.mcp.json', 'sub/.GIT/config']) {
      expect(judge(work(), 'Write', { file_path: p }).kind, p).toBe('ask');
      expect(judge(work(), 'Read', { file_path: p }).kind, p).toBe('allow');
    }
  });

  it('asks when a search pattern reaches outside', () => {
    expect(judge(look(), 'Glob', { pattern: '**/*.md' }).kind).toBe('allow');
    expect(judge(look(), 'Glob', { pattern: '/etc/*' }).kind).toBe('ask');
    expect(judge(look(), 'Glob', { pattern: '../*' }).kind).toBe('ask');
    expect(judge(look(), 'Grep', { pattern: 'x', path: '/' }).kind).toBe('ask');
    expect(judge(look(), 'Grep', { pattern: 'x', glob: '../**' }).kind).toBe('ask');
    expect(judge(look(), 'Grep', { pattern: 'x' }).kind).toBe('allow');
  });
});

describe('tools', () => {
  it('always asks before a shell command or opening a web page', () => {
    expect(judge(work(), 'Bash', { command: 'ls' }).kind).toBe('ask');
    expect(judge(work(), 'Bash', { command: 'sleep 99', run_in_background: true }).kind).toBe('deny');
    expect(judge(look(), 'WebFetch', { url: 'https://example.com' }).kind).toBe('ask');
    expect(judge(look(), 'WebSearch', { query: 'x' }).kind).toBe('allow');
  });

  it('refuses tools the bee was not given', () => {
    for (const t of ['Bash', 'Write', 'Edit', 'Agent', 'mcp__other__do']) {
      expect(judge(look(), t, { file_path: join(ws, 'a') }).kind, t).toBe('deny');
    }
    expect(judge(work(), 'Agent', {}).kind).toBe('deny');
    expect(toolsFor(look())).not.toContain('Bash');
    expect(toolsFor(look())).not.toContain('ExitPlanMode');
  });
});

describe('abilities', () => {
  it('a full bee has Claude Code’s tools, minus those that start unseen work', () => {
    for (const t of ['Agent', 'Skill', 'TodoWrite']) expect(judge(full(), t, {}).kind, t).toBe('allow');
    for (const t of ['AskUserQuestion', 'ExitPlanMode', 'Bash']) expect(judge(full(), t, {}).kind, t).toBe('ask');
    for (const t of ['CronCreate', 'RemoteTrigger', 'Workflow', 'ScheduleWakeup', 'Monitor', 'SendMessage']) {
      expect(judge(full(), t, {}).kind, t).toBe('deny');
    }
  });

  it('helpers cannot be put out of sight', () => {
    expect(judge(full(), 'Agent', { description: 'd', prompt: 'p', subagent_type: 'Explore', run_in_background: false }).kind).toBe('allow');
    for (const extra of [{ isolation: 'remote' }, { isolation: 'worktree' }, { run_in_background: true }, { cwd: '/' }, { mode: 'bypassPermissions' }, { team_name: 'x' }]) {
      expect(judge(full(), 'Agent', { prompt: 'p', ...extra }).kind, JSON.stringify(extra)).toBe('deny');
    }
  });

  it('a server can be used only if given, and then asks', () => {
    const b = { ...work(), abilities: { ...NO_ABILITIES, mcp: ['Neon'] } };
    expect(judge(b, 'mcp__Neon__run_sql', {}).kind).toBe('ask');
    expect(judge(b, 'mcp__kaggle__authorize', {}).kind).toBe('deny');
    expect(judge(work(), 'mcp__Neon__run_sql', {}).kind).toBe('deny');
  });

  it('browser use asks per site, and the bee cannot claim another site', () => {
    const b = { ...work(), abilities: { ...NO_ABILITIES, browser: true }, grants: [{ tool: 'browser', match: 'ok.example' }] };
    expect(judge(b, 'mcp__hive__browser_open', { url: 'ok.example/x' }).kind).toBe('allow');
    expect(judge(b, 'mcp__hive__browser_open', { url: 'https://ok.example.evil/x' }).kind).toBe('ask');
    const sees = (n: number) => n === 1;
    expect(judge(b, 'mcp__hive__browser_click', { ref: 1 }, { site: 'ok.example', sees }).kind).toBe('allow');
    expect(judge(b, 'mcp__hive__browser_click', { ref: 1, site: 'ok.example' }, { site: 'bank.example', sees }).kind).toBe('ask');
    // A number not on the page yet is never asked about: it could turn up on another site.
    for (const ref of [2, NaN, undefined]) {
      expect(judge(b, 'mcp__hive__browser_click', { ref }, { site: 'ok.example', sees }).kind).toBe('deny');
      expect(judge(b, 'mcp__hive__browser_type', { ref, text: 'x' }, { site: 'bank.example', sees }).kind).toBe('deny');
    }
    expect(judge(b, 'mcp__hive__browser_click', { ref: 1 }, { site: 'ok.example' }).kind).toBe('deny');
    expect(judge(work(), 'mcp__hive__browser_open', { url: 'ok.example' }).kind).toBe('deny');
    for (const url of ['\nhttps://ok.example/', 'http:/ok.example', 'https:ok.example']) {
      expect(judge(b, 'mcp__hive__browser_open', { url }).kind).toBe('deny');
      expect(grantFor('mcp__hive__browser_open', { url })).toBeNull();
    }
  });
});

describe('standing permissions', () => {
  it('cover only the exact command, site or tool', () => {
    const b = { ...work(), grants: [{ tool: 'Bash', match: 'npm test' }, { tool: 'WebFetch', match: 'docs.example' }] };
    expect(judge(b, 'Bash', { command: 'npm test' }).kind).toBe('allow');
    expect(judge(b, 'Bash', { command: 'npm test; echo more' }).kind).toBe('ask');
    expect(judge(b, 'Bash', { command: 'npm test', run_in_background: true }).kind).toBe('deny');
    expect(judge(b, 'Bash', { command: 'npm test', dangerouslyDisableSandbox: true }).kind).toBe('deny');
    expect(judge(b, 'WebFetch', { url: 'https://docs.example/a' }).kind).toBe('allow');
    // Addresses that read differently to a person, a browser and this program are refused outright.
    for (const url of ['https://docs.example@evil.example/', '\nhttps://docs.example/', 'https://docs.example/ x', 'https:\\\\docs.example', 'https://docs.example\u0000.evil.example', 'ftp://docs.example', 'http:/docs.example/', 'https:/docs.example', 'https:docs.example', 'https:///docs.example', 'http:80/x', 'docs.example', '']) {
      expect(judge(b, 'WebFetch', { url }).kind, JSON.stringify(url)).toBe('deny');
      expect(grantFor('WebFetch', { url }), JSON.stringify(url)).toBeNull();
    }
    expect(judge(b, 'WebFetch', { url: 'https://docs.example:8443/' }).kind).toBe('ask');
  });

  it('cannot be given for files, questions or plans', () => {
    for (const t of ['Write', 'Read', 'AskUserQuestion', 'ExitPlanMode']) expect(grantFor(t, { file_path: '/x' })).toBeNull();
  });
});

describe('confined shell', () => {
  it('says plainly what a command could do, and never grants the way out', () => {
    const why = (b: ReturnType<typeof work>, input: object) => {
      const v = judge(b, 'Bash', { command: 'ls', ...input });
      return v.kind === 'ask' ? v.reason : v.kind;
    };
    expect(why(work(), {})).toMatch(/confined/);
    expect(why(work(), { dangerouslyDisableSandbox: true })).toBe('deny');
    expect(why({ ...work(), confined: false }, {})).toMatch(/full rights/);
    expect(grantFor('Bash', { command: 'ls', dangerouslyDisableSandbox: true })).toBeNull();
    const free = { ...work(), confined: false, grants: [{ tool: 'Bash', match: 'ls' }] };
    expect(judge(free, 'Bash', { command: 'ls' }).kind).toBe('allow');
    expect(judge(free, 'Bash', { command: 'ls', dangerouslyDisableSandbox: true }).kind).toBe('ask');
  });

  it('is there only if the bee was given a shell', () => {
    const none = { ...work(), abilities: { ...NO_ABILITIES, shell: false } };
    expect(judge(none, 'Bash', { command: 'ls' }).kind).toBe('deny');
    expect(judge(none, 'SandboxNetworkAccess', { host: 'a.example' }).kind).toBe('deny');
    expect(judge(none, 'Write', { file_path: 'a' }).kind).toBe('allow');
  });

  it('asks before a command reaches a website, per site', () => {
    const b = { ...work(), grants: [{ tool: 'SandboxNetworkAccess', match: 'npmjs.org' }] };
    expect(judge(b, 'SandboxNetworkAccess', { host: 'npmjs.org' }).kind).toBe('allow');
    expect(judge(b, 'SandboxNetworkAccess', { host: 'evil.example' }).kind).toBe('ask');
    for (const host of ['', '*', 'a b', 'a\nb']) expect(grantFor('SandboxNetworkAccess', { host })).toBeNull();
    expect(judge(look(), 'SandboxNetworkAccess', { host: 'npmjs.org' }).kind).toBe('deny');
  });

  it('hides keys and Beekeep itself, and cannot write git hooks', () => {
    const bee = { mode: 'work', confined: true, workspace: ws, origin: null, abilities: NO_ABILITIES } as BeeRow;
    const s = sandboxFor(bee)!;
    expect(s).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false });
    expect(s.filesystem!.denyRead).toEqual(expect.arrayContaining([join(homedir(), '.ssh'), hiveHome()]));
    for (const p of ['hooks', 'config', 'commondir']) expect(s.filesystem!.denyWrite).toContain(join(ws, '.git', p));
    expect(sandboxFor({ ...bee, confined: false })).toBeUndefined();
    expect(sandboxFor({ ...bee, mode: 'look' })).toBeUndefined();
  });
});

describe('files owned by tasks', () => {
  it('asks before touching files outside the task, or owned by another', () => {
    const now = { claims: ['page', 'style.css'], taken: [join(ws, 'text.txt')] };
    expect(judge(work(), 'Write', { file_path: 'page/index.html' }, now).kind).toBe('allow');
    expect(judge(work(), 'Write', { file_path: 'style.css' }, now).kind).toBe('allow');
    expect(judge(work(), 'Write', { file_path: 'style.css.bak' }, now).kind).toBe('ask');
    expect(judge(work(), 'Write', { file_path: 'page/../other.txt' }, now).kind).toBe('ask');
    expect(judge(work(), 'Write', { file_path: 'text.txt' }, { taken: now.taken }).kind).toBe('ask');
    expect(judge(work(), 'Read', { file_path: 'text.txt' }, now).kind).toBe('allow');
  });
});

describe('workspaces', () => {
  it('creates a normal one and returns its real path', () => {
    expect(prepareWorkspace(join(ws, 'new'))).toBe(join(ws, 'new'));
  });

  it.each([['/'], ['~'], ['/Users'], ['relative/path'], ['~/.claude/x'], ['~/.ssh'], ['~/.beekeep/ws']])(
    'refuses %s',
    (p) => {
      expect(() => prepareWorkspace(p)).toThrow();
    },
  );

  it('refuses a link to a forbidden place', () => {
    symlinkSync(homedir(), join(ws, 'home'));
    expect(() => prepareWorkspace(join(ws, 'home'))).toThrow(/too broad/);
  });

  it('is not fooled by folder names that share a prefix', () => {
    expect(isInside(ws, ws + '-evil')).toBe(false);
    expect(isInside(ws, join(ws, '..foo'))).toBe(true);
  });
});

describe('logins', () => {
  const env = {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'sk-fake',
    ANTHROPIC_BASE_URL: 'http://x',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'o',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CONFIG_DIR: '/cfg',
  };

  it('leaves keys and providers out unless the person turns them on', () => {
    expect(beeEnv(env)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
    expect(beeEnv({ ...env, BEEKEEP_API_KEY: '1' })).toEqual({
      PATH: '/bin', BEEKEEP_API_KEY: '1', ANTHROPIC_API_KEY: 'sk-fake', ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'o', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
  });

  it('says what a bee runs on, and explains a missing login', () => {
    expect(loginOf({ subscriptionType: 'max', apiProvider: 'firstParty' })).toBe('your Claude max plan');
    expect(loginOf({ apiKeySource: 'ANTHROPIC_API_KEY' })).toBe('an API key (ANTHROPIC_API_KEY)');
    expect(loginOf({ apiProvider: 'bedrock' })).toBe('your bedrock account');
    expect(() => loginOf({ apiKeySource: 'none' })).toThrow(/not logged in/);
  });
});
