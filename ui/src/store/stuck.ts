// A stuck cause's bulk action (issue #1010, design.md "Stuck work"): POST /ui/api/failures/stuck/:cause. Its toast says
// how many moved, and the first refusal's why when some were refused; then Failures is read again. The daemon answers once
// each item is checked (issue #1194): each item but a Won't do is given back after, and the stream moves it.
import { toast } from 'sonner';
import { post, SessionRejected } from '@/lib/api';
import type { StuckActResult } from '@/model/wire';
import { refreshFailures, refreshLiveSoon, useHopper } from './index';

export async function stuckAct(cause: string): Promise<void> {
  try {
    const r = await post<Partial<StuckActResult>>(`/ui/api/failures/stuck/${encodeURIComponent(cause)}`, {});
    const done = r.done?.length ?? 0;
    const refused = r.refused ?? [];
    const moved = `${done} ${cause === 'wont_do' ? 'moved' : 'moving'}`;
    if (refused.length) toast.warning(`${moved}, ${refused.length} refused: ${refused[0]!.why}`);
    else toast.success(moved);
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error((e as Error).message);
  }
  refreshLiveSoon();
  refreshFailures().catch(() => {});
}
