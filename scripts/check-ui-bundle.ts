// node scripts/check-ui-bundle.ts <dist dir> — run by `npm run build:ui` after vite (issue #274), so
// install.sh, self-update (install.sh in build-only mode), the image and `npm run check` all fail on a
// UI bundle whose stylesheet is not a real Tailwind bundle. Tailwind finds the classes by scanning the
// source files and skips the ones a .gitignore covers, its own or a parent dir's: a build in a temp dir
// under a job's scratch dir (`.gitignore` of `*`) once shipped a ~15 KB stylesheet with no utilities,
// and the sign-in page rendered as logo shards with no controls (#272). A real one is ~90 KB.
// Checks the stylesheet index.html links: at least MIN_BYTES, and a rule for each of UTILITIES.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACT_LIBS } from '../src/artifacts/libs.ts';

const MIN_BYTES = 40_000;
/** Layout utilities every screen uses (the sign-in page among them); none is ever dropped by a real build. */
const UTILITIES = ['flex', 'h-8', 'w-full', 'items-center', 'justify-center', 'gap-2', 'text-sm', 'rounded-md', 'hidden', 'grid'];

const [dist] = process.argv.slice(2);
if (!dist) {
  console.error('usage: node scripts/check-ui-bundle.ts <ui dist dir>');
  process.exit(2);
}

function problems(dist: string): string[] {
  const index = join(dist, 'index.html');
  if (!existsSync(index)) return [`no ${index}`];
  const hrefs = [...readFileSync(index, 'utf8').matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="[^"]*\/assets\/([^"/]+\.css)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  if (hrefs.length === 0) return [`${index} links no stylesheet in assets/`];
  const out: string[] = [];
  for (const name of hrefs) {
    const path = join(dist, 'assets', name);
    if (!existsSync(path)) { out.push(`${index} links ${name}, which is not in assets/`); continue; }
    const size = statSync(path).size;
    if (size < MIN_BYTES) out.push(`${name} is ${size} bytes, far below a Tailwind bundle (at least ${MIN_BYTES})`);
    const css = readFileSync(path, 'utf8');
    const missing = UTILITIES.filter((u) => !new RegExp(`\\.${u.replace(/[-]/g, '\\-')}(?![\\w-])`).test(css));
    if (missing.length > 0) out.push(`${name} has no rule for ${missing.map((u) => `.${u}`).join(', ')}`);
  }
  // The libraries artifacts load (issue #675): the daemon refuses to start on a dir with one missing.
  for (const { file } of ARTIFACT_LIBS) if (!existsSync(join(dist, 'artifact-lib', file))) out.push(`no artifact-lib/${file} (scripts/copy-artifact-libs.ts)`);
  return out;
}

const found = problems(dist);
if (found.length > 0) {
  console.error(`UI bundle check failed (${dist}): Tailwind did not generate the utilities, so the UI would render unstyled.`);
  for (const p of found) console.error(`  - ${p}`);
  console.error('  Tailwind skips source files a .gitignore covers, including one in a parent dir: build from a git root of its own.');
  process.exit(1);
}
