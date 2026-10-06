// Issue #193: a native <select>'s option list is drawn by the browser in the page's colour scheme,
// but each option takes the text colour of the theme. The dark theme is a class on <html>, not the
// system's preference, so a light system drew white option text on a white list. Each theme states its
// colour scheme, and options take the popover colours, so the list matches the theme it is opened in.
// The native list cannot be drawn in happy-dom; this reads the stylesheet the UI is built from.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../ui/src/index.css', import.meta.url), 'utf8');

/** The declarations of the first top-level or base-layer rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) throw new Error(`no rule for ${selector} in ui/src/index.css`);
  return match[1];
}

describe('dropdowns follow the theme', () => {
  it('the light theme draws native controls light', () => {
    expect(block(':root')).toMatch(/color-scheme:\s*light\s*;/);
  });

  it('the dark theme draws native controls dark', () => {
    expect(block('.dark')).toMatch(/color-scheme:\s*dark\s*;/);
  });

  it('an option takes the popover colours, not the text colour of the field it opens from', () => {
    const option = block('option, optgroup');
    expect(option).toMatch(/bg-popover/);
    expect(option).toMatch(/text-popover-foreground/);
  });
});
