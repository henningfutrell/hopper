// Review sections in the store (issues #537, #543): GET /api/<section> for each — the open items and the history, with
// the section's settings and its type (parts, decisions) — read at load, on every (re)connect and after each of its
// events; and an admin's settings (POST /ui/api/<section>/settings).
import { toast } from 'sonner';
import { get, post, SessionRejected } from '@/lib/api';
import { REVIEW_KINDS, REVIEW_UI } from '@/model/reviews';
import type { ReviewItemView, ReviewKind, ReviewSectionView, ReviewSettings, ReviewSettingsView } from '@/model/wire';
import { HANDLED_LIMIT, useHopper } from './index';

type Read = { items: ReviewItemView[]; settings: ReviewSettingsView; type: ReviewSectionView };

/** An answer without its items, settings or type is refused, never read as none. */
export async function refreshReviews(kind: ReviewKind): Promise<void> {
  const path = `/api/${REVIEW_UI[kind].section}`;
  const [open, all] = await Promise.all([get<Read>(`${path}?status=open`), get<Read>(`${path}?status=all&limit=${HANDLED_LIMIT}`)]);
  if (!Array.isArray(open.items) || !Array.isArray(all.items) || !open.settings || !open.type) throw new Error(`GET ${path}: the answer holds no ${REVIEW_UI[kind].noun}s`);
  const s = useHopper.getState();
  useHopper.setState({
    reviews: { ...s.reviews, [kind]: { items: open.items, decided: all.items.filter((p) => p.status !== 'open' && p.status !== 'revising'), settings: open.settings, type: open.type } },
  });
}

/** Every review section. */
export const refreshAllReviews = (): void => { for (const k of REVIEW_KINDS) refreshReviews(k).catch(() => {}); };

const soon: Partial<Record<ReviewKind, ReturnType<typeof setTimeout>>> = {};
/** Debounced: a burst of events costs one read. */
export function refreshReviewsSoon(kind: ReviewKind): void {
  clearTimeout(soon[kind]);
  soon[kind] = setTimeout(() => { refreshReviews(kind).catch(() => {}); }, 150);
}

/** Failures toast; a rejected session drops to the landing page. */
export async function saveReviewSettings(kind: ReviewKind, body: ReviewSettings): Promise<void> {
  try {
    const settings = await post<ReviewSettingsView>(`/ui/api/${REVIEW_UI[kind].section}/settings`, body);
    const s = useHopper.getState();
    useHopper.setState({ reviews: { ...s.reviews, [kind]: { ...s.reviews[kind], settings } } });
    toast.success(`${REVIEW_UI[kind].label} settings saved`);
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error((e as Error).message);
  }
}
