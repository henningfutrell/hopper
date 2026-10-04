// `npm run plugin:check <dir>` (design.md "Settled in slice 6"): type-checks a plugin directory with
// `job-hopper/plugin` mapped to src/plugins/sdk.ts, then runs the real loader, parses the options
// with their defaults and runs detect, one line per plugin; non-zero on any failure. Every example
// under examples/plugins passes, and there is one per role.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLES } from '../../src/domain/types.ts';
import { useTempDirs } from '../plugins/support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const EXAMPLES = join(ROOT, 'examples', 'plugins');
const temp = useTempDirs();

function check(dir: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'plugin-check.ts'), dir], { encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const write = (dir: string, name: string, source: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'index.ts'), source);
};

const GOOD = `import type { PluginDefinition } from 'job-hopper/plugin';
export default {
  id: 'good-usage', role: 'usage-source', describe: 'fine',
  options: (z) => z.object({ used: z.number().default(1) }),
  async detect() { return { status: 'available' }; },
  create(ctx, o) { return { name: ctx.instanceName, async poll() { return [{ source: ctx.instanceName, used: o.used, limit: 10, unit: '%', at: ctx.clock.now().toISOString() }]; } }; },
} satisfies PluginDefinition<'usage-source'>;
`;

describe('plugin:check', () => {
  it('examples/plugins: one minimal plugin per role, every one passes (exit 0)', () => {
    const r = check(EXAMPLES);
    expect(r.out).toMatch(/type-check: ok/);
    for (const role of ROLES) expect(r.out).toMatch(new RegExp(`^ok +${role} `, 'm'));
    expect(r.out).not.toMatch(/^FAIL/m);
    expect(r.code).toBe(0);
  });

  it('a directory that is one plugin (index.ts in it) is checked as that plugin', () => {
    const dir = temp();
    write(dir, 'good', GOOD);
    const r = check(join(dir, 'good'));
    expect(r.out).toMatch(/^ok +usage-source +good-usage /m);
    expect(r.code).toBe(0);
  });

  it('a type error fails the check, naming the file', () => {
    const dir = temp();
    write(dir, 'good', GOOD);
    write(dir, 'typo', GOOD.replace("'good-usage'", "'typo-usage'").replace('used: o.used', 'used: o.usd'));
    const r = check(dir);
    expect(r.out).toMatch(/type-check: FAIL/);
    expect(r.out).toMatch(/typo\/index\.ts/);
    expect(r.code).not.toBe(0);
  });

  it('a module that is not a plugin, options without defaults, a detect that throws, a built-in id: each FAIL with its reason; the good one still ok', () => {
    const dir = temp();
    write(dir, 'good', GOOD);
    write(dir, 'no-default', 'export const x = 1;\n');
    write(dir, 'required', GOOD.replace("'good-usage'", "'required-usage'").replace('z.number().default(1)', 'z.number()'));
    write(dir, 'throws', GOOD.replace("'good-usage'", "'throws-usage'").replace("async detect() { return { status: 'available' }; }", "async detect() { throw new Error('kaboom'); }"));
    write(dir, 'taken', GOOD.replace("'good-usage'", "'local'"));
    const r = check(dir);
    expect(r.out).toMatch(/^ok +usage-source +good-usage /m);
    expect(r.out).toMatch(/^FAIL .*no-default.*no default export/m);
    expect(r.out).toMatch(/^FAIL .*required-usage.*options/m);
    expect(r.out).toMatch(/^FAIL .*throws-usage.*kaboom/m);
    expect(r.out).toMatch(/^FAIL .*taken.*built-in/m);
    expect(r.code).not.toBe(0);
  });

  it('a plugin that cannot run here is reported with its detection, and is not a failure', () => {
    const dir = temp();
    write(dir, 'elsewhere', GOOD.replace("'good-usage'", "'elsewhere-usage'").replace("return { status: 'available' };", "return { status: 'unavailable', reason: 'not on this machine' };"));
    const r = check(dir);
    expect(r.out).toMatch(/^ok +usage-source +elsewhere-usage .*unavailable: not on this machine/m);
    expect(r.code).toBe(0);
  });

  it('no plugin found: a failure', () => {
    const r = check(temp());
    expect(r.out).toMatch(/no plugin/);
    expect(r.code).not.toBe(0);
  });

  it('an example copied out of the tree still checks (job-hopper/plugin resolves through the mapping)', () => {
    const dir = temp();
    cpSync(join(EXAMPLES, 'notifier'), join(dir), { recursive: true });
    const r = check(dir);
    expect(r.out).toMatch(/type-check: ok/);
    expect(r.code).toBe(0);
  });
});
