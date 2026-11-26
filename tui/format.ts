// How the terminal shows things. Pure functions, so they can be tested.
import type { ApprovalRow, BeeView, EventRow, PlanRow, TaskRow } from '../server/types.ts';
import { STATUS_WORD, toolDetail, toolSummary, toolWord } from '../web/src/format.ts';

export interface Line {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

/**
 * Text from bees, files and web pages may carry terminal control codes, which
 * could change the person's terminal (its title, clipboard, or what is shown).
 * Only plain text and line breaks get through.
 */
export function plain(text: unknown): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '');
}

/** Breaks text into lines no wider than `width`. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const out: string[] = [];
  for (const raw of plain(text).split('\n')) {
    let rest = raw;
    while ([...rest].length > w) {
      const chars = [...rest];
      let cut = chars.slice(0, w).join('').lastIndexOf(' ');
      if (cut < w / 2) cut = w;
      out.push(chars.slice(0, cut).join('').trimEnd());
      rest = chars.slice(cut).join('').trimStart();
    }
    out.push(rest);
  }
  return out;
}

const first = (text: unknown, max = 3) => plain(text).trim().split('\n').slice(0, max).join('\n');

/** The lines one event adds to a bee's pane. */
export function eventLines(e: EventRow, bee: BeeView | undefined, width: number): Line[] {
  const d = e.data;
  const lines = (text: string, style: Omit<Line, 'text'> = {}) => wrap(text, width).map((t) => ({ text: t, ...style }));
  const helper = d.helper ? '  ' : '';
  switch (e.kind) {
    case 'order':
      return [{ text: '' }, ...lines(`› ${d.source === 'you' ? 'you' : 'order'}: ${first(d.text, 6)}`, { color: 'cyan', bold: true })];
    case 'say':
      return lines(helper + first(d.text, 40));
    case 'think':
      return lines(`${helper}… ${first(d.text, 1)}`, { dim: true });
    case 'action': {
      const tool = String(d.tool);
      const what = toolSummary(tool, (d.input ?? {}) as Record<string, unknown>, bee?.workspace ?? '');
      return lines(`${helper}⏺ ${toolWord(tool)} ${first(what, 1)}`, { color: 'blue' });
    }
    case 'result':
      return d.ok === false ? lines(`${helper}  ✗ ${first(d.text, 2)}`, { color: 'red' }) : [];
    case 'approval':
      return lines(`? asks: ${toolWord(String(d.tool))} ${first(toolSummary(String(d.tool), (d.input ?? {}) as Record<string, unknown>, bee?.workspace ?? ''), 1)}`, { color: 'magenta' });
    case 'decision':
      return lines(`  ${d.decision === 'allowed' ? '✓ you said yes' : d.decision === 'denied' ? '✗ you said no' : '· request withdrawn'}`, { dim: true });
    case 'note':
    case 'message':
      return lines(first(d.text, 4), { dim: true });
    case 'error':
      return lines(`✗ ${first(d.text, 3)}`, { color: 'red' });
    case 'turn': {
      if (d.ok === false) return lines(d.stopped ? '■ stopped' : `✗ ${first((d.errors as string[] | undefined)?.[0] ?? 'failed', 2)}`, { color: 'red' });
      const secs = Number(d.durationMs ?? 0) / 1000;
      return lines(`— done in ${secs < 10 ? secs.toFixed(1) : Math.round(secs)} s`, { dim: true });
    }
    default:
      return [];
  }
}

/** The last `height` lines of a bee's pane. */
export function paneLines(events: EventRow[], bee: BeeView, typing: string, width: number, height: number): Line[] {
  const all = events.flatMap((e) => eventLines(e, bee, width));
  if (typing) all.push(...wrap(typing, width).map((text) => ({ text, dim: true })));
  if (all.length === 0) all.push({ text: `Press Enter to give ${plain(bee.name)} an order.`, dim: true });
  return all.slice(-Math.max(1, height));
}

export const GLYPH: Record<BeeView['status'], { mark: string; color: string }> = {
  off: { mark: '·', color: 'gray' },
  idle: { mark: '○', color: 'green' },
  busy: { mark: '●', color: 'yellow' },
  waiting: { mark: '◆', color: 'magenta' },
  stopping: { mark: '■', color: 'yellow' },
  error: { mark: '✗', color: 'red' },
};

export function beeLabel(b: BeeView): string {
  return `${b.kind === 'queen' ? '♛ ' : ''}${plain(b.name)}`;
}

export function statusWord(b: BeeView): string {
  return STATUS_WORD[b.status];
}

/** What the person is asked, with enough detail to decide. */
export function approvalLines(a: ApprovalRow, bees: BeeView[], width: number, max: number): Line[] {
  const who = plain(bees.find((b) => b.id === a.beeId)?.name ?? 'A bee');
  const head = wrap(`${who}: ${plain(a.reason)}`, width).map((text) => ({ text, bold: true }));
  const detail = wrap(toolDetail(a.tool, a.input), width).slice(0, max).map((text) => ({ text }));
  return [...head, ...detail];
}

export function planLines(p: PlanRow, tasks: TaskRow[], bees: BeeView[], width: number): Line[] {
  const name = (id: string) => plain(bees.find((b) => b.id === id)?.name ?? '?');
  const out: Line[] = wrap(`${name(p.queenId)} plans: ${plain(p.goal)}`, width).map((text) => ({ text, bold: true }));
  for (const t of tasks) {
    const after = t.deps.length ? ` (after ${t.deps.join(', ')})` : '';
    out.push(...wrap(`  ${t.key} → ${name(t.beeId)}: ${plain(t.title)}${after}`, width).map((text) => ({ text })));
  }
  return out;
}
