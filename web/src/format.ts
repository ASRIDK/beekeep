import { siteOf } from '../../server/address.ts';
import type { ApprovalRow, BeeMode, BeeStatus, BeeView, EventRow, PlanStatus, TaskStatus } from '../../server/types.ts';

export const STATUS_WORD: Record<BeeStatus, string> = {
  off: 'asleep',
  idle: 'ready',
  busy: 'working',
  waiting: 'needs you',
  stopping: 'stopping',
  error: 'had a problem',
};

export const MODE_WORD: Record<BeeMode, string> = { look: 'look only', work: 'may edit', full: 'all tools' };

export const PLAN_WORD: Record<PlanStatus, string> = {
  proposed: 'waiting for you',
  running: 'running',
  done: 'done',
  failed: 'ended with problems',
  stopped: 'stopped',
  refused: 'refused',
};

export const TASK_WORD: Record<TaskStatus, string> = {
  planned: 'planned',
  waiting: 'waiting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

/** Who an order came from. */
export function sourceWord(source: string, bees: BeeView[]): string {
  if (source === 'you') return 'Order from you';
  if (source === 'hive') return 'News from Beekeep';
  if (source === 'auto') return 'Order from a rule';
  if (source === 'outside') return 'Order from another session';
  return `Order from ${bees.find((b) => b.id === source)?.name ?? 'a bee'}`;
}

/** The label of a standing yes, where one can be given. Must match the server's grantFor. */
export function canAlways(a: ApprovalRow): string | null {
  if (a.tool === 'Bash') return a.input.dangerouslyDisableSandbox ? null : 'Always allow this exact command';
  if (a.tool === 'SandboxNetworkAccess') return a.input.host ? `Always allow ${String(a.input.host)}` : null;
  if (a.tool === 'WebFetch') return siteOf(a.input.url) ? `Always allow ${siteOf(a.input.url)}` : null;
  if (a.tool.startsWith('mcp__hive__browser_')) {
    const site = a.tool === 'mcp__hive__browser_open' ? siteOf(a.input.url) : String(a.input.site ?? '');
    return site ? `Always allow on ${site}` : null;
  }
  if (a.tool.startsWith('mcp__')) return 'Always allow this tool';
  return null;
}

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

export function time(ts: number): string {
  return clock.format(ts);
}

export function dayLabel(ts: number): string {
  return new Date(ts).toDateString() === new Date().toDateString() ? 'Today' : day.format(ts);
}

const TOOL_WORD: Record<string, string> = {
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  Glob: 'Find files',
  Grep: 'Search text',
  Bash: 'Shell',
  WebSearch: 'Search web',
  WebFetch: 'Open page',
  NotebookEdit: 'Edit notebook',
  Agent: 'Helper',
  Skill: 'Skill',
  TodoWrite: 'To-do list',
  AskUserQuestion: 'Question',
  EnterPlanMode: 'Start planning',
  ExitPlanMode: 'Plan',
  ToolSearch: 'Find tool',
  SandboxNetworkAccess: 'the internet',
  mcp__hive__propose_plan: 'Propose plan',
  mcp__hive__list_bees: 'List bees',
  mcp__hive__check_plan: 'Check plan',
  mcp__hive__retry_task: 'Retry task',
  mcp__hive__stop_task: 'Stop task',
  mcp__hive__score_task: 'Score task',
  mcp__hive__finish_task: 'Hand in task',
  mcp__hive__ask_queen: 'Ask queen',
  mcp__hive__post: 'Post to board',
  mcp__hive__read_board: 'Read board',
  mcp__hive__message: 'Message',
  mcp__hive__tell_neighbours: 'Tell neighbours',
  mcp__hive__browser_open: 'Open in browser',
  mcp__hive__browser_look: 'Look at page',
  mcp__hive__browser_click: 'Click',
  mcp__hive__browser_type: 'Type in page',
};

export function toolWord(tool: string): string {
  return TOOL_WORD[tool] ?? tool.replace(/^mcp__([^_]+(?:_[^_]+)*)__/, '$1 ').replaceAll('_', ' ');
}

type Input = Record<string, unknown>;

/** The one thing that identifies a tool call, short enough for a line. */
export function toolSummary(tool: string, input: Input, workspace: string): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const path = (p: string) => (p.startsWith(workspace + '/') ? p.slice(workspace.length + 1) : p);
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return path(s('file_path'));
    case 'Glob':
      return s('pattern');
    case 'Grep':
      return s('path') ? `${s('pattern')} in ${path(s('path'))}` : s('pattern');
    case 'Bash':
      return s('command');
    case 'WebSearch':
      return s('query');
    case 'WebFetch':
    case 'mcp__hive__browser_open':
      return s('url');
    case 'mcp__hive__propose_plan':
      return s('goal');
    case 'mcp__hive__finish_task':
      return s('report');
    case 'mcp__hive__message':
      return `${s('to')}: ${s('text')}`;
    case 'Agent':
      return s('description');
    case 'Skill':
      return s('skill');
    default:
      return Object.keys(input).length ? JSON.stringify(input) : '';
  }
}

/** Everything the person needs to see before saying yes. */
export function toolDetail(tool: string, input: Input): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (tool) {
    case 'Bash': {
      const { command: _, description: __, ...rest } = input;
      return Object.keys(rest).length ? `${s('command')}\n\n${JSON.stringify(rest)}` : s('command');
    }
    case 'Write':
      return `${s('file_path')}\n\n${s('content')}`;
    case 'Edit':
      return `${s('file_path')}\n\nReplace:\n${s('old_string')}\n\nWith:\n${s('new_string')}`;
    case 'WebFetch':
      return s('url');
    case 'Read':
      return s('file_path');
    case 'ExitPlanMode':
      return s('plan') || JSON.stringify(input, null, 2);
    default:
      return JSON.stringify(input, null, 2);
  }
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function thousands(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

export function shortPath(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + '/')) ? `~${p.slice(home.length)}` : p;
}

export function modelWord(bee: BeeView): string {
  return bee.model[0]!.toUpperCase() + bee.model.slice(1);
}

/** Text a failed or stopped turn should show, if any. */
export function turnProblem(e: EventRow): string | null {
  if (e.kind !== 'turn' || e.data.ok) return null;
  if (e.data.stopped) return 'You stopped this.';
  const errors = e.data.errors as string[] | undefined;
  return errors?.[0] ?? null;
}
