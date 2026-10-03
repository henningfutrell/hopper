import { describe, expect, it } from 'vitest';
import type { PluginDefinition } from '../../src/plugins/sdk.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';

const withOptions: PluginDefinition<'router'> = {
  id: 'opt', role: 'router', describe: 'd',
  options: (z) => z.object({ model: z.string().default('opus'), retries: z.number().int().min(0) }),
  async detect() { return { status: 'available' }; },
  create() { throw new Error('unused'); },
};
const without: PluginDefinition<'router'> = { ...withOptions, id: 'none', options: undefined };

describe('plugin options (zod, from the injected z)', () => {
  it('validates with safeParse and applies defaults', () => {
    expect(parseOptions(withOptions, { retries: 2 })).toEqual({ ok: true, options: { model: 'opus', retries: 2 } });
  });

  it('reports every issue with its path', () => {
    const r = parseOptions(withOptions, { retries: -1, model: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/retries.*model|model.*retries/);
  });

  it('a plugin without options takes none (absent → {})', () => {
    expect(parseOptions(without, undefined)).toEqual({ ok: true, options: {} });
  });

  it('exposes the options as JSON Schema', () => {
    expect(optionsJsonSchema(withOptions)).toMatchObject({
      type: 'object',
      properties: { model: { type: 'string', default: 'opus' }, retries: { type: 'integer', minimum: 0 } },
      required: ['retries'],
    });
    expect(optionsJsonSchema(without)).toMatchObject({ type: 'object', properties: {} });
  });

  it('a plugin whose options function throws is an error, not a crash', () => {
    const broken: PluginDefinition<'router'> = { ...withOptions, options: () => { throw new Error('nope'); } };
    expect(parseOptions(broken, {})).toEqual({ ok: false, error: expect.stringContaining('nope') });
  });
});
