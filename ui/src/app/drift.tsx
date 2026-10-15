// A stack drifted from the compose file of its version (issue #697): one banner over every view, from GET /api/update/drift
// — each gap, what it turns off, and the fix: the update's compose commands with the image the hopper runs (issue #970), for the container tool
// this browser chose. Not dismissable: it ends when the stack matches. Read once signed in, then each minute. When OpenFGA is
// one of its gaps, the OpenFGA banner (#696) gives way: one cause, said once.
import { LogBlock } from '@/components/log-block';
import { Layers } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { setContainerTool, useContainerTool } from '@/hooks/use-container-tool';
import { get } from '@/lib/api';
import { asDrift, driftFix, driftNamesOpenFga } from '@/model/drift';
import { CONTAINER_TOOLS } from '@/model/update';
import type { StackDrift } from '@/model/wire';
import { useHopper } from '@/store';
import { AccessBanner, useAccessStatus } from './access';

const POLL_MS = 60_000;

/** GET /api/update/drift once signed in, then each minute; null until read, or when it cannot be read. */
export function useStackDrift(): StackDrift | null {
  const authed = useHopper((s) => s.authed);
  const [drift, setDrift] = useState<StackDrift | null>(null);
  useEffect(() => {
    if (!authed) return;
    const read = () => { get<unknown>('/api/update/drift').then((b) => setDrift(asDrift(b)), () => setDrift(null)); };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, [authed]);
  return drift;
}

export function DriftBanner({ drift }: { drift: StackDrift | null }) {
  const tool = useContainerTool();
  if (!drift || drift.state !== 'checked' || drift.gaps.length === 0) return null;
  const fix = drift.image ? driftFix(drift.image, tool) : undefined;
  return (
    <div data-stack-drift className="space-y-2 rounded-lg border border-bad/40 bg-bad/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-bad"><Layers className="size-4" />This hopper's stack differs from the compose file of its version</p>
      <ul className="list-disc space-y-1 pl-5 text-xs break-words">
        {drift.gaps.map((g) => (
          <li key={`${g.kind}:${g.name}`}>
            <span className="text-bad">{g.what}</span>{g.kind === 'setting' && <> (<code>{g.name}</code>)</>}
            {g.off && <span className="text-muted-foreground">. Off until then: {g.off}.</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <p className="min-w-0 flex-1 text-muted-foreground">
          The fix: in the folder that holds <code>compose.yaml</code>, run the update with the image this hopper runs. It puts in that
          image's <code>compose.yaml</code>, then pulls and recreates the whole stack, with the master key given. Never recreate the hopper's container alone.
        </p>
        <div className="flex gap-1">
          {CONTAINER_TOOLS.map((t) => (
            <Button key={t} size="xs" variant={t === tool ? 'secondary' : 'ghost'} aria-pressed={t === tool} onClick={() => setContainerTool(t)}>{t}</Button>
          ))}
        </div>
      </div>
      {fix
        ? <LogBlock title="Command" copy={fix} contentClassName="text-[11px]">{fix}</LogBlock>
        : <p className="text-xs text-muted-foreground">This hopper does not know its image: give <code>HOPPER_IMAGE</code> at launch, then see How to update.</p>}
    </div>
  );
}

/** The stack's banners: the drift, and the OpenFGA one unless the drift already names it. */
export function StackNotices() {
  const drift = useStackDrift();
  const access = useAccessStatus();
  return (
    <>
      <DriftBanner drift={drift} />
      {!driftNamesOpenFga(drift) && <AccessBanner status={access} />}
    </>
  );
}
