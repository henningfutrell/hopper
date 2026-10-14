// Keeps the reading position in a list that changes under the reader (issue #450). The anchor is the
// first item whose top is on screen (else the one across the top of the screen): after every change
// it is put back where it was, so an item that arrives, leaves or grows above it moves nothing in
// view. If the anchor itself left, the next item still there takes its place. Items that arrive below
// the screen are held in a count, for an "N new below" that scrolls to them. Items carry
// `data-<attr>` with their id. The browser's own scroll anchoring (`overflow-anchor`) is not used:
// Safari has none, and it holds no position at the top of the page.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

interface Anchor { ids: string[]; top: number }

/** The ids that arrived below the screen and are not yet in view. */
function heldIds() {
  let ids: string[] = [];
  const subs = new Set<() => void>();
  return {
    get: () => ids,
    set(next: string[]) {
      if (next.length === ids.length && next.every((id, i) => id === ids[i])) return;
      ids = next;
      for (const f of subs) f();
    },
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}

const itemsIn = (list: HTMLElement | null, attr: string) => [...(list?.querySelectorAll<HTMLElement>(`[data-${attr}]`) ?? [])];
const offScreen = (el: HTMLElement | undefined) => !!el && el.getBoundingClientRect().top >= window.innerHeight;

/** Measures the list and keeps it in place: `record` notes where the anchor is, `hold` puts it back. */
function positionKeeper(list: RefObject<HTMLElement | null>, attr: string, held: ReturnType<typeof heldIds>) {
  let anchor: Anchor | null = null;
  const find = (id: string) => itemsIn(list.current, attr).find((el) => el.dataset[attr] === id);
  const record = () => {
    const all = itemsIn(list.current, attr);
    const box = all.map((el) => el.getBoundingClientRect());
    const onScreen = box.findIndex((r) => r.top >= 0 && r.top < window.innerHeight);
    const i = onScreen >= 0 ? onScreen : box.findIndex((r) => r.bottom > 0);
    anchor = i < 0 ? null : { ids: all.slice(i).map((el) => el.dataset[attr]!), top: box[i]!.top };
    held.set(held.get().filter((id) => offScreen(find(id))));
  };
  const hold = () => {
    const el = anchor?.ids.map(find).find(Boolean);
    if (anchor && el) {
      const moved = el.getBoundingClientRect().top - anchor.top;
      if (moved) window.scrollBy(0, moved);
    }
    record();
  };
  return { find, record, hold };
}

/** `changed`: anything else whose change may move items (a card grown by an attempt). */
export function useReadingPosition(list: RefObject<HTMLElement | null>, attr: string, ids: string[], changed: unknown) {
  const [held] = useState(heldIds);
  const [keeper] = useState(() => positionKeeper(list, attr, held));
  const known = useRef<Set<string> | null>(null);
  const below = useSyncExternalStore(held.subscribe, held.get);

  const key = ids.join(',');
  useLayoutEffect(() => {
    keeper.hold();
    const now = key ? key.split(',') : [];
    const before = known.current;
    const arrived = before?.size ? now.filter((id) => !before.has(id) && offScreen(keeper.find(id))) : [];
    known.current = new Set(now);
    held.set([...held.get().filter((id) => known.current!.has(id)), ...arrived]);
  }, [key, changed, keeper, held]);

  useEffect(() => {
    window.addEventListener('scroll', keeper.record, { passive: true });
    window.addEventListener('resize', keeper.record);
    // A card can change size without the list rendering again (its job moved on, a section opened).
    const sized = typeof ResizeObserver === 'undefined' || !list.current ? undefined : new ResizeObserver(keeper.hold);
    if (sized && list.current) sized.observe(list.current);
    return () => { window.removeEventListener('scroll', keeper.record); window.removeEventListener('resize', keeper.record); sized?.disconnect(); };
  }, [list, keeper]);

  const showBelow = () => {
    const el = below.map(keeper.find).find(Boolean);
    held.set([]);
    // Below the sticky header (3.5rem), with a margin.
    if (el) window.scrollBy({ top: el.getBoundingClientRect().top - 72, behavior: 'smooth' });
  };
  return { below: below.length, showBelow };
}
