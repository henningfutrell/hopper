// Drag one item onto another to place it there (issue #86), with the browser's own drag and drop:
// no library — the platform does it, and the overview and Customize are its only two users.
// `props(id)` goes on each item; while `enabled` is false an item is neither dragged nor a target.
import { useRef, useState, type DragEvent } from 'react';

export function useDragToPlace<T extends string>(onPlace: (id: T, at: T) => void, enabled = true) {
  const dragged = useRef<T | null>(null);
  const [dragging, setDragging] = useState<T | null>(null);
  const [over, setOver] = useState<T | null>(null);
  const end = () => { dragged.current = null; setDragging(null); setOver(null); };

  const props = (id: T) => enabled ? {
    draggable: true,
    'data-dragging': dragging === id || undefined,
    'data-drop-target': over === id && dragging !== id || undefined,
    onDragStart: (e: DragEvent) => {
      dragged.current = id;
      setDragging(id);
      // Firefox starts a drag only with data set; the id travels in the ref.
      e.dataTransfer?.setData('text/plain', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnter: (e: DragEvent) => { if (dragged.current !== null) { e.preventDefault(); setOver(id); } },
    onDragOver: (e: DragEvent) => {
      if (dragged.current === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    },
    onDrop: (e: DragEvent) => {
      const from = dragged.current;
      if (from === null) return;
      e.preventDefault();
      end();
      onPlace(from, id);
    },
    onDragEnd: end,
  } : {};

  return { props, dragging };
}
