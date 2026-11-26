import type { IDockviewPanelProps } from 'dockview-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import type { BrowserView } from '../../../server/types.ts';
import type { PaneParams } from '../layout.ts';
import { attempt, call, getState, onFrame, onReconnect, useHive } from '../link.ts';
import { Icon, ICON } from '../parts.tsx';

// The page is drawn by a separate Chrome with its own profile. This pane shows
// its picture and passes on mouse and keys.
export function BrowserPane({ params, api }: IDockviewPanelProps<PaneParams>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const page = useRef({ width: 1100, height: 750 });
  const [id, setId] = useState(params.browserId);
  const [problem, setProblem] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const view = useHive((s) => s.browsers.find((b) => b.id === id));
  const url = view?.url ?? params.url ?? '';

  useEffect(() => {
    if (view) api.setTitle(view.title || view.url.replace(/^https?:\/\//, '') || 'Browser');
  }, [view?.title, view?.url, api]);

  useEffect(() => {
    let gone = false;
    async function begin() {
      try {
        let now = getState().browsers.some((b) => b.id === params.browserId) ? params.browserId : undefined;
        if (!now) {
          const made = await call<BrowserView>('browser.open', { space: getState().space, url: params.url ?? 'about:blank' });
          now = made.id;
        }
        if (gone) return;
        api.updateParameters({ browserId: now, url: undefined });
        setId(now);
        setProblem(null);
      } catch (err) {
        if (!gone) setProblem((err as Error).message);
      }
    }
    void begin();
    const off = onReconnect(() => void begin());
    return () => {
      gone = true;
      off();
    };
  }, []);

  useEffect(() => {
    if (!id) return;
    const off = onFrame(id, (f) => {
      page.current = { width: f.width, height: f.height };
      const img = new Image();
      img.onload = () => {
        const c = canvas.current;
        if (!c) return;
        if (c.width !== img.width || c.height !== img.height) {
          c.width = img.width;
          c.height = img.height;
        }
        c.getContext('2d')!.drawImage(img, 0, 0);
      };
      img.src = `data:image/jpeg;base64,${f.data}`;
    });
    call('browser.watch', { id, on: true }).catch(() => {});
    const fit = () => {
      const r = box.current?.getBoundingClientRect();
      if (!r || r.width < 200 || r.height < 150) return;
      call('browser.size', { id, width: Math.round(r.width), height: Math.round(r.height) }).catch(() => {});
    };
    const watch = new ResizeObserver(fit);
    watch.observe(box.current!);
    return () => {
      off();
      watch.disconnect();
      call('browser.watch', { id, on: false }).catch(() => {});
    };
  }, [id]);

  const send = (input: object) => id && call('browser.input', { id, input }).catch(() => {});

  function at(e: { clientX: number; clientY: number }) {
    const r = canvas.current!.getBoundingClientRect();
    return {
      x: Math.max(0, ((e.clientX - r.left) / r.width) * page.current.width),
      y: Math.max(0, ((e.clientY - r.top) / r.height) * page.current.height),
    };
  }

  function go(e: FormEvent) {
    e.preventDefault();
    if (id && typed) void attempt('browser.go', { id, url: typed });
    setTyped(null);
    canvas.current?.focus();
  }

  const button = (b: number) => (b === 2 ? 'right' : 'left');

  return (
    <div className="browser">
      <form className="browser-bar row" onSubmit={go}>
        <button type="button" className="icon" aria-label="Back" onClick={() => id && attempt('browser.move', { id, way: 'back' })}>
          <Icon d={ICON.back} />
        </button>
        <button type="button" className="icon" aria-label="Forward" onClick={() => id && attempt('browser.move', { id, way: 'forward' })}>
          <Icon d={ICON.forward} />
        </button>
        <button type="button" className="icon" aria-label="Reload" onClick={() => id && attempt('browser.move', { id, way: 'reload' })}>
          <Icon d={ICON.reload} />
        </button>
        <input
          aria-label="Address"
          spellCheck={false}
          value={typed ?? url}
          onChange={(e) => setTyped(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => setTyped(null)}
        />
      </form>
      <div className="browser-box" ref={box}>
        {problem ? (
          <p className="problem pad">{problem}</p>
        ) : (
          <canvas
            ref={canvas}
            tabIndex={0}
            aria-label={`Web page ${view?.title ?? ''}`}
            onContextMenu={(e) => e.preventDefault()}
            onMouseMove={(e) => send({ kind: 'mouse', type: 'mouseMoved', ...at(e), button: e.buttons & 1 ? 'left' : 'none', clicks: 0 })}
            onMouseDown={(e) => {
              e.currentTarget.focus();
              send({ kind: 'mouse', type: 'mousePressed', ...at(e), button: button(e.button), clicks: Math.min(3, e.detail || 1) });
            }}
            onMouseUp={(e) => send({ kind: 'mouse', type: 'mouseReleased', ...at(e), button: button(e.button), clicks: Math.min(3, e.detail || 1) })}
            onWheel={(e) => send({ kind: 'wheel', ...at(e), dx: e.deltaX, dy: e.deltaY })}
            onKeyDown={(e) => {
              if (e.metaKey && e.key.toLowerCase() !== 'a') return;
              e.preventDefault();
              if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ kind: 'text', text: e.key });
              else send({ kind: 'key', key: e.key, down: true });
            }}
            onKeyUp={(e) => {
              if (e.key.length > 1) send({ kind: 'key', key: e.key, down: false });
            }}
            onPaste={(e) => send({ kind: 'text', text: e.clipboardData.getData('text') })}
          />
        )}
      </div>
    </div>
  );
}
