// Zooming a time graph by hand (issue #502): pinch with two fingers, or Ctrl/⌘ + scroll (a trackpad pinch);
// drag across a stretch with a mouse or one finger; hover with a mouse, or tap. While a pinch or a scroll
// runs, the graph draws the stretch it would show (`preview`); it is applied once the gesture ends, so the
// graph reads its history once per gesture. Vertical swipes stay the page's: the area is `touch-action: pan-y`.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { selected, zoomed, type Stretch, type ZoomLimits } from '@/model/usage-history';

/** A drag shorter than this many pixels is a tap or a click, not a stretch. */
const MIN_DRAG_PX = 8;
/** A scroll zoom applies this long after the last wheel event. */
const WHEEL_SETTLE_MS = 250;

export interface GraphZoom {
  /** The stretch to draw: the gesture's, while one runs. */
  shown: Stretch;
  hoverT: number | null;
  /** The stretch being dragged across. */
  drag: Stretch | null;
  handlers: {
    onPointerDown: (e: React.PointerEvent<Element>) => void;
    onPointerMove: (e: React.PointerEvent<Element>) => void;
    onPointerUp: (e: React.PointerEvent<Element>) => void;
    onPointerCancel: (e: React.PointerEvent<Element>) => void;
    onPointerLeave: (e: React.PointerEvent<Element>) => void;
  };
}

/**
 * `area` is the plot area (its left edge is `stretch.from`, its width `width` pixels); `maxMs` the widest stretch
 * (the history kept); `onZoom` gets the stretch a gesture chose. Without `onZoom`, hover only.
 */
export function useGraphZoom(o: {
  area: React.RefObject<Element | null>; width: number; stretch: Stretch; maxMs: number; onZoom?: (s: Stretch) => void;
}): GraphZoom {
  const [preview, setPreview] = useState<Stretch | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [drag, setDrag] = useState<Stretch | null>(null);
  const pointers = useRef(new Map<number, number>());
  const pinch = useRef<{ dist: number; at: number } | null>(null);
  const shown = preview ?? o.stretch;
  // What the wheel listener, registered once, reads.
  const live = useRef({ o, shown });
  useLayoutEffect(() => { live.current = { o, shown }; });
  const limits = (): ZoomLimits => ({ now: Date.now(), maxMs: live.current.o.maxMs });

  const timeAt = (clientX: number): number => {
    const { o: { area, width }, shown: s } = live.current;
    const left = area.current?.getBoundingClientRect().left ?? 0;
    return s.from + ((clientX - left) / Math.max(width, 1)) * (s.to - s.from);
  };
  const apply = (s: Stretch) => { setPreview(null); live.current.o.onZoom?.(s); };

  // Ctrl/⌘ + scroll: React's wheel listener is passive, and a zoom must keep the page from zooming.
  useEffect(() => {
    const el = o.area.current;
    if (!el || !o.onZoom) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let pending: Stretch | null = null;
    const wheel = (e: Event) => {
      const w = e as WheelEvent;
      if (!w.ctrlKey && !w.metaKey) return;
      w.preventDefault();
      const base = pending ?? live.current.shown;
      pending = zoomed(base, Math.exp(Math.max(-1, Math.min(1, w.deltaY * 0.01))), timeAt(w.clientX), limits());
      setPreview(pending);
      clearTimeout(settle);
      settle = setTimeout(() => { const s = pending; pending = null; if (s) apply(s); }, WHEEL_SETTLE_MS);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { el.removeEventListener('wheel', wheel); clearTimeout(settle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- timeAt and apply read the live props
  }, [o.area, Boolean(o.onZoom)]);

  const end = (e: React.PointerEvent<Element>, commit: boolean) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) {
      if (pointers.current.size < 2) {
        pinch.current = null;
        if (commit && preview) apply(preview); else setPreview(null);
      }
      return;
    }
    if (drag) {
      const px = Math.abs(drag.to - drag.from) / Math.max(shown.to - shown.from, 1) * o.width;
      if (commit && px >= MIN_DRAG_PX && o.onZoom) o.onZoom(selected(drag.from, drag.to, limits()));
      setDrag(null);
    }
  };

  return {
    shown, hoverT, drag,
    handlers: {
      onPointerDown(e) {
        pointers.current.set(e.pointerId, e.clientX);
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        setHoverT(timeAt(e.clientX));
        if (!o.onZoom) return;
        if (pointers.current.size === 2) {
          const [a, b] = [...pointers.current.values()] as [number, number];
          pinch.current = { dist: Math.max(Math.abs(a - b), 1), at: timeAt((a + b) / 2) };
          setDrag(null);
        } else if (pointers.current.size === 1) {
          const t = timeAt(e.clientX);
          setDrag({ from: t, to: t });
        }
      },
      onPointerMove(e) {
        if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, e.clientX);
        if (pinch.current && pointers.current.size >= 2) {
          const [a, b] = [...pointers.current.values()] as [number, number];
          setPreview(zoomed(o.stretch, pinch.current.dist / Math.max(Math.abs(a - b), 1), pinch.current.at, limits()));
          return;
        }
        const t = timeAt(e.clientX);
        setHoverT(t);
        if (drag) setDrag({ from: drag.from, to: t });
      },
      onPointerUp: (e) => end(e, true),
      onPointerCancel: (e) => end(e, false),
      onPointerLeave(e) { if (e.pointerType === 'mouse' && !drag) setHoverT(null); },
    },
  };
}
