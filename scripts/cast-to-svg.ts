// Turns an asciinema recording into one animated SVG for the README, by replaying
// it in a terminal emulator and drawing each screen. No other tools needed.
// Run: node scripts/cast-to-svg.ts docs/demo.cast docs/demo.svg
import { readFileSync, writeFileSync } from 'node:fs';
import xterm from '@xterm/headless';

const [input = 'docs/demo.cast', output = 'docs/demo.svg'] = process.argv.slice(2);
const [head, ...rest] = readFileSync(input, 'utf8').trim().split('\n');
const { width: cols, height: rows } = JSON.parse(head!) as { width: number; height: number };
const events = rest.map((l) => JSON.parse(l) as [number, string, string]).filter((e) => e[1] === 'o');

const BG = '#14181d';
const FG = '#d6dbe1';
const ANSI = [
  '#1f2329', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
  '#5c6370', '#ef7d87', '#a9d38b', '#f0cf8c', '#74bdf7', '#d48ce8', '#67c7d3', '#e6e9ee',
];
function palette(i: number): string {
  if (i < 16) return ANSI[i]!;
  if (i < 232) {
    const n = i - 16;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
const rgb = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CW = 8.4;
const LH = 18;
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
const write = (d: string) => new Promise<void>((r) => term.write(d, r));

/** One row as SVG text, each run of equal style in its own tspan. */
function rowMarkup(y: number): string {
  const line = term.buffer.active.getLine(y);
  if (!line) return '';
  const parts: string[] = [];
  const boxes: string[] = [];
  let run = '';
  let runStyle = '';
  let runX = 0;
  const flush = () => {
    if (run.trim()) parts.push(`<tspan x="${(runX * CW).toFixed(1)}"${runStyle}>${esc(run)}</tspan>`);
    run = '';
  };
  const cell = line.getCell(0)!;
  for (let x = 0; x < cols; x++) {
    line.getCell(x, cell);
    if (cell.getWidth() === 0) continue;
    let fg = cell.isFgDefault() ? FG : cell.isFgPalette() ? palette(cell.getFgColor()) : rgb(cell.getFgColor());
    let bg = cell.isBgDefault() ? null : cell.isBgPalette() ? palette(cell.getBgColor()) : rgb(cell.getBgColor());
    if (cell.isInverse()) [fg, bg] = [bg ?? BG, fg];
    if (bg) boxes.push(`<rect x="${(x * CW).toFixed(1)}" y="${y * LH}" width="${(CW * cell.getWidth() + 0.5).toFixed(1)}" height="${LH}" fill="${bg}"/>`);
    const style = `${fg !== FG ? ` fill="${fg}"` : ''}${cell.isBold() ? ' font-weight="bold"' : ''}${cell.isDim() ? ' opacity="0.6"' : ''}`;
    const ch = cell.getChars() || ' ';
    if (style !== runStyle || ch === ' ' && run.endsWith(' ') && false) {
      flush();
      runStyle = style;
      runX = x;
    }
    if (!run) runX = x;
    run += ch;
  }
  flush();
  return `${boxes.join('')}<text y="${y * LH + 13}">${parts.join('')}</text>`;
}

const screen = () => Array.from({ length: rows }, (_, y) => rowMarkup(y)).join('');

// Replay, keeping a frame whenever the screen settles to something new.
const frames: { t: number; svg: string }[] = [];
for (let i = 0; i < events.length; i++) {
  const [t, , data] = events[i]!;
  await write(data);
  const next = events[i + 1]?.[0];
  if (next !== undefined && next - t < 0.08) continue;
  const svg = screen();
  if (frames.at(-1)?.svg === svg) continue;
  frames.push({ t, svg });
}
const total = (events.at(-1)?.[0] ?? 0) + 3;

const W = cols * CW;
const H = rows * LH;
const PAD = 14;
const BAR = 26;
const steps = frames
  .map((f, i) => `${((f.t / total) * 100).toFixed(3)}%{transform:translateY(${-i * H}px)}`)
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W + PAD * 2}" height="${H + PAD * 2 + BAR}" viewBox="0 0 ${W + PAD * 2} ${H + PAD * 2 + BAR}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14">
<style>.film{animation:play ${total.toFixed(1)}s steps(1,end) infinite}@keyframes play{${steps}}text{white-space:pre;fill:${FG}}</style>
<rect width="100%" height="100%" rx="10" fill="${BG}"/>
<circle cx="${PAD + 6}" cy="${PAD + 4}" r="6" fill="#ff5f57"/><circle cx="${PAD + 26}" cy="${PAD + 4}" r="6" fill="#febc2e"/><circle cx="${PAD + 46}" cy="${PAD + 4}" r="6" fill="#28c840"/>
<svg x="${PAD}" y="${PAD + BAR}" width="${W}" height="${H}"><g class="film">${frames.map((f, i) => `<g transform="translate(0 ${i * H})">${f.svg}</g>`).join('')}</g></svg>
</svg>
`;
writeFileSync(output, svg);
console.log(`${frames.length} frames, ${total.toFixed(1)} s, ${(svg.length / 1024).toFixed(0)} KB -> ${output}`);
