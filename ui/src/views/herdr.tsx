// herdr (issue #189, design.md "The herdr terminal"): an actual terminal in the page — xterm.js on a
// WebSocket to a client of the root herdr, which runs on the hopper's machine and lists the herdr of
// every attached machine it reaches over ssh in its sidebar. Admin only: the terminal is a shell on
// the hopper's machine. Above it, each machine and whether the root herdr lists it.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { RotateCw, SquareTerminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePoll } from '@/hooks/use-poll';
import { get, post, SessionRejected } from '@/lib/api';
import { cn } from '@/lib/utils';
import { inputMessage, machineLine, resizeMessage, socketUrl, type Tone } from '@/model/herdr-terminal';
import type { HerdrTerminalStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const TONE: Record<Tone, string> = { good: 'bg-ok', bad: 'bg-bad', neutral: 'bg-busy', muted: 'bg-muted-foreground/40' };

function Machines({ status }: { status: HerdrTerminalStatus | null }) {
  if (!status) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="font-mono text-muted-foreground">{status.session}</span>
      {status.problem && <span className="text-bad">{status.problem}</span>}
      {status.machines.map((m) => {
        const line = machineLine(m);
        return (
          <Tooltip key={m.name}>
            <TooltipTrigger asChild>
              <span className={cn('flex items-center gap-1.5', line.tone === 'muted' && 'text-muted-foreground')}>
                <span className={cn('size-1.5 rounded-full', TONE[line.tone])} />{m.label}
              </span>
            </TooltipTrigger>
            <TooltipContent>{line.text}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

type Conn = 'connecting' | 'open' | 'closed';

function Screen({ generation, onConn }: { generation: number; onConn: (c: Conn, why?: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current!;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, scrollback: 5000, allowProposedApi: false,
      fontFamily: css.getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace',
      theme: { background: '#0b0b0f', foreground: '#e4e4e7', cursor: '#e4e4e7', selectionBackground: '#3f3f4680' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    let ws: WebSocket | undefined;
    let ended = false;
    onConn('connecting');
    post<{ ticket: string }>('/ui/api/herdr-terminal/ticket').then(({ ticket }) => {
      if (ended) return;
      ws = new WebSocket(socketUrl(window.location, ticket, { cols: term.cols, rows: term.rows }));
      ws.onopen = () => { onConn('open'); term.focus(); };
      ws.onmessage = (e) => { term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer)); };
      ws.onclose = (e) => { if (!ended) onConn('closed', e.reason || undefined); };
    }, (e: Error) => {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      onConn('closed', e.message);
    });
    const keys = term.onData((d) => { if (ws?.readyState === WebSocket.OPEN) ws.send(inputMessage(d)); });
    const sized = term.onResize((s) => { if (ws?.readyState === WebSocket.OPEN) ws.send(resizeMessage(s)); });
    const observer = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });
    observer.observe(el);
    return () => {
      ended = true;
      observer.disconnect();
      keys.dispose();
      sized.dispose();
      ws?.close();
      term.dispose();
    };
  }, [generation, onConn]);
  return <div ref={host} data-slot="herdr-terminal" className="h-full w-full" />;
}

export function Herdr() {
  const admin = useCanAdmin();
  const [status, setStatus] = useState<HerdrTerminalStatus | null>(null);
  const [generation, setGeneration] = useState(0);
  const [conn, setConn] = useState<{ c: Conn; why?: string }>({ c: 'connecting' });
  const read = useCallback(() => get<HerdrTerminalStatus>('/api/herdr-terminal').then(setStatus), []);
  usePoll(read, 10000);
  const onConn = useCallback((c: Conn, why?: string) => setConn({ c, ...(why ? { why } : {}) }), []);

  if (!admin) {
    return (
      <div className="space-y-3">
        <Machines status={status} />
        <div className="rounded-lg border p-6 text-sm text-muted-foreground">
          The herdr terminal is a shell on the hopper&apos;s machine that reaches every machine&apos;s herdr: sign in as an admin to open it.
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-[calc(100dvh-3.5rem-1.5rem)] flex-col gap-2 sm:h-[calc(100dvh-3.5rem-2rem)] lg:h-[calc(100dvh-3.5rem-3rem)]">
      <div className="flex flex-wrap items-center gap-2">
        <SquareTerminal className="size-4 text-muted-foreground" />
        <Machines status={status} />
        <span className={cn('ml-auto text-xs', conn.c === 'closed' ? 'text-bad' : 'text-muted-foreground')}>
          {conn.c === 'open' ? 'connected' : conn.c === 'connecting' ? 'connecting…' : `disconnected${conn.why ? `: ${conn.why}` : ''}`}
        </span>
        <Button size="sm" variant="outline" onClick={() => { setGeneration((g) => g + 1); void read(); }}><RotateCw />Reconnect</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-[#0b0b0f] p-1.5">
        <Screen generation={generation} onConn={onConn} />
      </div>
    </div>
  );
}
