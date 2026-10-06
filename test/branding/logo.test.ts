// Issue #132: the teal rabbit silhouette is hopper's logo. One file, site/hopper-logo.svg, scales by
// viewBox alone; the install page, the UI (favicon and top bar) and the README all load that file.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const LOGO = join(ROOT, 'site', 'hopper-logo.svg');

describe('the hopper logo', () => {
  it('is the teal rabbit SVG, sized by viewBox only', () => {
    expect(existsSync(LOGO)).toBe(true);
    const svg = readFileSync(LOGO, 'utf8');
    expect(svg).toContain('viewBox="0 0 233.78 364"');
    expect(svg).toContain('fill="#1ECAD4"');
    expect(svg).not.toMatch(/<svg[^>]*\s(width|height)=/);
  });

  it('is the install page favicon and heading mark', () => {
    const page = read('site', 'install.html');
    expect(page).toMatch(/<link rel="icon" type="image\/svg\+xml" href="hopper-logo\.svg">/);
    expect(page).toMatch(/<img[^>]*src="hopper-logo\.svg"/);
    expect(page).not.toContain('data:image/svg+xml');
  });

  it('is the UI favicon and top-bar mark, from the same file', () => {
    expect(read('ui', 'index.html')).toContain('href="../site/hopper-logo.svg"');
    const header = read('ui', 'src', 'app', 'header.tsx');
    expect(header).toContain("from '../../../site/hopper-logo.svg'");
    expect(header).not.toMatch(/\bRabbit\b/);
  });

  it('is in every copy the UI is built from: the install script and the container build', () => {
    expect(read('scripts', 'install.sh')).toContain('cp "$APP_DIR/site/hopper-logo.svg" "$BUILD/site/"');
    expect(read('Dockerfile')).toContain('COPY site/hopper-logo.svg ./site/hopper-logo.svg');
  });

  it('heads the README', () => {
    expect(read('README.md')).toMatch(/^<img src="site\/hopper-logo\.svg"/);
  });
});
