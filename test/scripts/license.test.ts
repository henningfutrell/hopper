// Issue #561: the repo is MIT licensed. LICENSE at the root carries the standard MIT text, package.json says so,
// the README ends with a License section, and every page of the Pages site names the license in its footer.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8');
const LICENSE_URL = 'https://github.com/henningfutrell/hopper/blob/dev/LICENSE';

describe('the MIT license', () => {
  it('is LICENSE at the repo root, in the standard MIT text', () => {
    const license = read('LICENSE');
    expect(license.startsWith('MIT License\n\nCopyright (c) 2026 ')).toBe(true);
    expect(license).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy');
    expect(license).toContain('The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.');
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });

  it('is the license package.json declares', () => {
    expect((JSON.parse(read('package.json')) as { license?: string }).license).toBe('MIT');
  });

  it('closes the README', () => {
    expect(read('README.md').trimEnd().endsWith('## License\n\nMIT, see [LICENSE](LICENSE).')).toBe(true);
  });

  it.each(['index.html', 'install.html', 'guide.html'])('is linked from the footer of site/%s', (page) => {
    const footer = /<footer[\s\S]*<\/footer>/.exec(read('site', page))?.[0] ?? '';
    expect(footer).toContain(`<a href="${LICENSE_URL}" class="hover:text-foreground">MIT license</a>`);
  });
});
