// A stuck cause's bulk action (issue #1010, design.md "Stuck work"): POST /ui/api/failures/stuck/:cause. Its toast says
// how many moved, and the first refusal's why when some were refused; then Failures is read again.
import { toast } from 'sonner';
import { post, SessionRejected } from '@/lib/api';
import type { StuckActResult } from '@/model/wire';
import { refreshFailures, refreshLiveSoon, useHopper } from './index';

export async function stuckAct(cause: string): Promise<void> {
  try {
    const r = await post<Partial<StuckActResult>>(`/ui/api/failures/stuck/${encodeURIComponent(cause)}`, {});
    const done = r.done?.length ?? 0;
    const refused = r.refused ?? [];
    if (refused.length) toast.warning(`${done} moved, ${refused.length} refused: ${refused[0]!.why}`);
    else toast.success(`${done} moved`);
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error((e as Error).message);
  }
  refreshLiveSoon();
  refreshFailures().catch(() => {});
}
