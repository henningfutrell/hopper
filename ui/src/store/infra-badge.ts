// The Infra changes nav badge (issues #871, #897): how many out-of-band changes no one has marked yet. Read again
// whenever an infra event arrives on the stream.
import { useEffect, useState } from 'react';
import { get } from '@/lib/api';
import type { OutOfBandView } from '@/model/wire';
import { useHopper } from '@/store';

export function useOutOfBandOpen(): number {
  const seq = useHopper((s) => s.events.find((e) => e.type.startsWith('infra.'))?.seq ?? 0);
  const [open, setOpen] = useState(0);
  useEffect(() => {
    let live = true;
    get<{ changes: OutOfBandView[] }>('/api/out-of-band').then((r) => { if (live) setOpen(r.changes.filter((c) => !c.marked).length); }, () => { if (live) setOpen(0); });
    return () => { live = false; };
  }, [seq]);
  return open;
}
