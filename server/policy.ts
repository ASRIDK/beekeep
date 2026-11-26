import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { siteOf } from './address.ts';
import { isInside, realLocation } from './paths.ts';
import type { Abilities, BeeMode, BeeRow, Grant } from './types.ts';

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string };

/** What the decision depends on beyond the bee itself. */
export interface Situation {
  /** Files the bee's current task owns, relative to its folder. Empty means no claim. */
  claims?: string[];
  /** Files owned by other tasks that are running right now, as full paths. */
  taken?: string[];
  /** Where the bee's browser page is right now. */
  site?: string;
  /** Whether a numbered thing is one the bee's browser shows right now. */
  sees?: (ref: number) => boolean;
}

const LOOK = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const WORK = [...LOOK, 'Write', 'Edit', 'Bash'];
// The rest of Claude Code that stays visible in Beekeep. Left out on purpose: tools
// that start work Beekeep cannot see or stop (schedules, cloud sessions, workflows).
const FULL = [
  ...WORK, 'NotebookEdit', 'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ToolSearch', 'Agent', 'Skill',
  'AskUserQuestion', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
];

// Harmless on their own: bookkeeping, or things whose effects are judged separately.
const QUIET = new Set([
  'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ToolSearch', 'Agent', 'Skill', 'EnterPlanMode',
  'WebSearch',
]);

export function toolsFor(bee: { mode: BeeMode; abilities: Abilities }): string[] {
  const all = bee.mode === 'full' ? FULL : bee.mode === 'work' ? WORK : LOOK;
  const base = bee.abilities.shell ? all : all.filter((t) => t !== 'Bash');
  const extra: string[] = [];
  // A bee that can change things can also be told to plan first.
  if (bee.mode !== 'look') extra.push('EnterPlanMode', 'ExitPlanMode');
  if (bee.abilities.questions) extra.push('AskUserQuestion');
  if (bee.abilities.helpers) extra.push('Agent');
  if (bee.abilities.skills.length || bee.abilities.project) extra.push('Skill');
  if (bee.abilities.mcp.length) extra.push('ToolSearch');
  return [...new Set([...base, ...extra])];
}

const ALLOW: Verdict = { kind: 'allow' };

// Files other programs run or trust by themselves. Changing one can make
// something execute later, so these need a yes even inside the workspace.
const PROTECTED = new Set([
  '.git', '.claude', '.vscode', '.idea', '.husky', '.github', '.mcp.json', '.envrc', '.npmrc', '.gitconfig',
  '.gitmodules', '.zshrc', '.zshenv', '.zprofile', '.bashrc', '.bash_profile', '.profile', 'hive.json',
]);

export type Judged = Pick<BeeRow, 'mode' | 'workspace' | 'abilities' | 'grants' | 'confined'>;

/** Decides one tool call: run it, ask the person, or refuse it. */
/** What a helper may be started with. Anything else could put it out of sight. */
const HELPER = new Set(['description', 'prompt', 'subagent_type', 'model', 'effort']);

export function judge(bee: Judged, tool: string, input: Record<string, unknown>, now: Situation = {}): Verdict {
  const verdict = weigh(bee, tool, input, now);
  return verdict.kind === 'ask' && granted(bee.grants, tool, withSite(tool, input, now)) ? ALLOW : verdict;
}

function weigh(bee: Judged, tool: string, input: Record<string, unknown>, now: Situation): Verdict {
  // The sandbox asks before a command may reach a website.
  if (tool === 'SandboxNetworkAccess') {
    return bee.mode === 'look' || !bee.abilities.shell ? { kind: 'deny', reason: 'This bee has no shell.' } : { kind: 'ask', reason: `Let a command reach ${String(input.host ?? 'the internet')}.` };
  }
  if (tool.startsWith('mcp__hive__browser_')) return browse(bee, tool, input, now);
  if (tool.startsWith('mcp__hive__')) return ALLOW;
  if (tool.startsWith('mcp__')) {
    const server = tool.split('__')[1] ?? '';
    return bee.abilities.mcp.includes(server)
      ? { kind: 'ask', reason: `Use ${server}: ${tool.split('__').slice(2).join(' ')}` }
      : { kind: 'deny', reason: `${server} is not connected to this bee.` };
  }
  if (!toolsFor(bee).includes(tool)) return { kind: 'deny', reason: `${tool} is not available to this bee.` };
  if (tool === 'Agent' && Object.entries(input).some(([k, v]) => !HELPER.has(k) && v !== undefined && v !== null && v !== false)) {
    return { kind: 'deny', reason: 'Helpers work here, in the open: no other folder, no cloud, not in the background.' };
  }
  if (QUIET.has(tool)) return ALLOW;

  switch (tool) {
    case 'Read':
      return inWorkspace(bee.workspace, input.file_path, 'read', now);
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return inWorkspace(bee.workspace, input.file_path ?? input.notebook_path, 'change', now);
    case 'Glob':
    case 'Grep': {
      const pattern = String((tool === 'Glob' ? input.pattern : input.glob) ?? '');
      if (isAbsolute(pattern) || pattern.startsWith('~') || pattern.split('/').includes('..')) {
        return { kind: 'ask', reason: `Search reaches outside the workspace: ${pattern}` };
      }
      return inWorkspace(bee.workspace, input.path ?? '.', 'search', now);
    }
    case 'WebFetch':
      if (!fetchSite(input)) return { kind: 'deny', reason: 'Write the whole address, starting with https://.' };
      return { kind: 'ask', reason: `Open a web page: ${String(input.url ?? '')}` };
    case 'AskUserQuestion':
      return { kind: 'ask', reason: 'Asks you a question.' };
    case 'ExitPlanMode':
      return { kind: 'ask', reason: 'Wants a yes to its plan before changing anything.' };
    case 'Bash':
      // A command left running could wake the bee later, outside any order.
      if (input.run_in_background) return { kind: 'deny', reason: 'Background commands are not allowed. Run it in the foreground.' };
      if (bee.confined && input.dangerouslyDisableSandbox) {
        return { kind: 'deny', reason: 'This bee’s commands stay in their sandbox. If that cannot work, say so; the keeper can lift it.' };
      }
      return {
        kind: 'ask',
        reason: bee.confined ? 'Run a shell command, confined to its folder.' : 'Run a shell command with your full rights.',
      };
    default:
      return { kind: 'ask', reason: `Use ${tool}.` };
  }
}

function browse(bee: Judged, tool: string, input: Record<string, unknown>, now: Situation): Verdict {
  if (!bee.abilities.browser) return { kind: 'deny', reason: 'This bee has no browser.' };
  if (tool === 'mcp__hive__browser_look') return ALLOW;
  if (tool === 'mcp__hive__browser_open' && !siteOf(input.url)) return { kind: 'deny', reason: 'That is not a plain web address.' };
  if (tool === 'mcp__hive__browser_open') return { kind: 'ask', reason: `Open ${String(input.url ?? '')} in the browser.` };
  // A number must be known when asked, or a yes for this page could hit a later one.
  if (!now.sees?.(Number(input.ref))) return { kind: 'deny', reason: 'Nothing has that number now. Use browser_look.' };
  const what = tool === 'mcp__hive__browser_type' ? 'Type on' : 'Click on';
  return { kind: 'ask', reason: `${what} ${now.site || 'the open page'} in the browser.` };
}

function inWorkspace(workspace: string, value: unknown, verb: string, now: Situation): Verdict {
  if (typeof value !== 'string' || value === '') return { kind: 'ask', reason: `Wants to ${verb} an unclear path.` };
  const target = value.startsWith('~') ? value : resolve(workspace, value);
  try {
    // Plan mode keeps its plan here; the person is shown it for a yes.
    if (verb === 'change' && isInside(join(homedir(), '.claude/plans'), target)) return ALLOW;
    if (!target.startsWith('~') && isInside(workspace, target)) {
      if (verb !== 'change') return ALLOW;
      const rel = relative(realLocation(workspace), realLocation(target));
      const guarded = rel.split(sep).find((part) => PROTECTED.has(part.toLowerCase()));
      if (guarded) return { kind: 'ask', reason: `Wants to change a protected file (${guarded}): ${value}` };
      if (now.claims?.length && !now.claims.some((c) => isInside(resolve(workspace, c), target))) {
        return { kind: 'ask', reason: `Wants to change a file its task does not own: ${rel}` };
      }
      if (now.taken?.some((t) => isInside(t, target))) {
        return { kind: 'ask', reason: `Another bee's running task owns this file: ${rel}` };
      }
      return ALLOW;
    }
  } catch {
    // Unresolvable path: fall through and ask.
  }
  return { kind: 'ask', reason: `Wants to ${verb} outside its workspace: ${value}` };
}

// Standing permissions

/** Clicking and typing happen wherever the page is, which the bee does not get to claim. */
export function withSite(tool: string, input: Record<string, unknown>, now: Situation): Record<string, unknown> {
  return tool === 'mcp__hive__browser_click' || tool === 'mcp__hive__browser_type' ? { ...input, site: now.site ?? '' } : input;
}

/** Claude Code reads this address itself, so it must be one that cannot be read two ways. */
const fetchSite = (input: Record<string, unknown>) => siteOf(input.url, { bare: false });

/** The narrowest standing yes that would cover this call, or null if none makes sense. */
export function grantFor(tool: string, input: Record<string, unknown>): Grant | null {
  // Extra switches could change what a command does, so only the plain form can be granted.
  if (tool === 'Bash') {
    const plain = !input.run_in_background && !input.dangerouslyDisableSandbox;
    return input.command && plain ? { tool, match: String(input.command) } : null;
  }
  if (tool === 'WebFetch') return fetchSite(input) ? { tool, match: fetchSite(input) } : null;
  if (tool === 'SandboxNetworkAccess') return /^[\w.:[\]-]+$/.test(String(input.host ?? '')) ? { tool, match: String(input.host) } : null;
  if (tool.startsWith('mcp__hive__browser_')) {
    const host = tool === 'mcp__hive__browser_open' ? siteOf(input.url) : String(input.site ?? '');
    return host ? { tool: 'browser', match: host } : null;
  }
  if (tool.startsWith('mcp__')) return { tool };
  return null;
}

function granted(grants: Grant[], tool: string, input: Record<string, unknown>): boolean {
  const need = grantFor(tool, input);
  return need !== null && grants.some((g) => g.tool === need.tool && g.match === need.match);
}
