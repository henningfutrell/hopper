// A pane's terminal (issue #1128): its screen, read through the hopper again every 1.5 s, and a person's text or keys to
// it. The job's terminal and the machine's share it; each names its routes and what every request carries (the pane).
// Keyed by its pane where it changes, so a new pane starts with an empty screen. The screen is a code block (issue #1169):
// numbered lines, a wrap toggle and Copy.
import { SendHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { LogBlock } from '@/components/log-block';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { post } from '@/lib/api';
import { TERMINAL_KEY_BUTTONS, TERMINAL_POLL_MS } from '@/model/terminal';

const MAX_TEXT = 4000;

interface Screen { screen: string; at: string }

/** `base`: the routes' prefix (`…/terminal`); `with`: what each request carries besides the input. */
export function PaneTerminal({ base, with: extra, toolbar }: { base: string; with?: Record<string, string>; toolbar?: React.ReactNode }) {
  const [screen, setScreen] = useState<Screen | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLPreElement>(null);
  const key = JSON.stringify(extra ?? {});

  useEffect(() => {
    let stop = false;
    const read = async () => {
      try {
        const s = await post<Screen>(`${base}/screen`, JSON.parse(key) as Record<string, string>);
        if (!stop) { setScreen(s); setError(undefined); }
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void read();
    const timer = setInterval(() => void read(), TERMINAL_POLL_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [base, key]);
  useEffect(() => { bottom.current?.scrollTo?.({ top: bottom.current.scrollHeight }); }, [screen?.screen]);

  const send = async (input: { text: string } | { keys: string[] }) => {
    setBusy(true);
    try {
      await post(`${base}/input`, { ...extra, ...input });
      setError(undefined);
      if ('text' in input) setText('');
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span data-slot="pane-terminal-at">{screen ? `read ${screen.at}` : 'reading the pane…'}</span>
        <span className="ml-auto flex gap-1">{toolbar}</span>
      </div>
      {error && <div data-slot="pane-terminal-error" className="text-xs text-bad">{error}</div>}
      <div data-slot="pane-terminal-screen">
        <LogBlock title="The pane" copy={screen?.screen ?? ''} lineNumbers contentRef={bottom} contentClassName="max-h-96 text-xs leading-tight">
          {screen?.screen ?? ''}
        </LogBlock>
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text !== '') void send({ text }); }}>
        <Input value={text} maxLength={MAX_TEXT} placeholder="Text for the pane, as you would type it" aria-label="Text for the pane"
          onChange={(e) => setText(e.target.value)} />
        <Button size="sm" type="submit" variant="outline" disabled={busy || text === ''}><SendHorizontal />Type</Button>
      </form>
      <div className="flex flex-wrap gap-1">
        {TERMINAL_KEY_BUTTONS.map((k) => (
          <Button key={k.key} size="sm" variant="outline" data-key={k.key} disabled={busy} onClick={() => void send({ keys: [k.key] })}>{k.label}</Button>
        ))}
      </div>
    </>
  );
}
