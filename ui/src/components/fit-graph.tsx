// A graph drawn at its layout's size that fits its panel (issue #2354): by default the SVG scales down to the panel's
// width through its viewBox, so a wide tree never scrolls sideways; Actual size draws it at its layout's size, and only
// then does it scroll across. A graph narrower than its panel is never scaled up.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function FitGraph({ slot, label, width, height, children }: {
  slot: string; label: string; width: number; height: number; children: React.ReactNode;
}) {
  const [actual, setActual] = useState(false);
  return (
    <div data-slot="fit-graph" data-size={actual ? 'actual' : 'fit'}>
      <div className="mb-1 flex justify-end">
        <Button type="button" size="xs" variant="ghost" aria-pressed={actual} onClick={() => setActual((a) => !a)}>
          {actual ? 'Fit to width' : 'Actual size'}
        </Button>
      </div>
      <div className={cn(actual && 'overflow-x-auto')}>
        <svg data-slot={slot} viewBox={`0 0 ${width} ${height}`} width={width} height={height}
          className={cn('block', !actual && 'h-auto max-w-full')} role="group" aria-label={label}>
          {children}
        </svg>
      </div>
    </div>
  );
}
