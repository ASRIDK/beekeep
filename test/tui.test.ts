import { describe, expect, it } from 'vitest';
import type { ApprovalRow, BeeView, EventRow } from '../server/types.ts';
import { approvalLines, eventLines, paneLines, plain, wrap } from '../tui/format.ts';

const bee = { id: 'b1', name: 'Worker 1', workspace: '/w', status: 'busy', kind: 'worker' } as BeeView;
const ev = (kind: EventRow['kind'], data: Record<string, unknown>, id = 1): EventRow => ({ id, beeId: 'b1', ts: 0, kind, data });
const text = (lines: { text: string }[]) => lines.map((l) => l.text).join('\n');

describe('the terminal screen', () => {
  it('never passes control codes from bees or pages to the terminal', () => {
    const hostile = 'ok\x1b]52;c;ZXZpbA==\x07\x1b[2J\x9b31m‮reversed\rnext\x00';
    const out = plain(hostile);
    expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f‮]/);
    expect(out).toBe('ok]52;c;ZXZpbA==[2J31mreversed\nnext');
    for (const line of [...eventLines(ev('say', { text: hostile }), bee, 40), ...eventLines(ev('action', { tool: 'Bash', input: { command: hostile } }), bee, 40)]) {
      expect(line.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    }
    const ask = { id: 1, beeId: 'b1', tool: 'Bash', input: { command: hostile }, reason: hostile, status: 'waiting' } as unknown as ApprovalRow;
    for (const line of approvalLines(ask, [bee], 40, 5)) expect(line.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it('wraps at words, and cuts words longer than a line', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('a'.repeat(20), 8)).toEqual(['aaaaaaaa', 'aaaaaaaa', 'aaaa']);
    expect(wrap('x\ny', 10)).toEqual(['x', 'y']);
  });

  it('shows what a bee does in a line each, and only failed results', () => {
    expect(text(eventLines(ev('action', { tool: 'Edit', input: { file_path: '/w/src/a.ts' } }), bee, 60))).toContain('src/a.ts');
    expect(eventLines(ev('result', { ok: true, text: 'long output' }), bee, 60)).toEqual([]);
    expect(text(eventLines(ev('result', { ok: false, text: 'boom' }), bee, 60))).toContain('✗ boom');
    expect(text(eventLines(ev('turn', { ok: false, stopped: true }), bee, 60))).toContain('stopped');
    expect(text(eventLines(ev('order', { source: 'you', text: 'Fix it' }), bee, 60))).toContain('› you: Fix it');
  });

  it('keeps the newest lines in view, with live typing last', () => {
    const many = Array.from({ length: 50 }, (_, i) => ev('say', { text: `line ${i}` }, i));
    const lines = paneLines(many, bee, 'typing now', 40, 5);
    expect(text(lines)).toBe('line 46\nline 47\nline 48\nline 49\ntyping now');
    expect(text(paneLines([], bee, '', 40, 5))).toContain('Press Enter');
  });
});
