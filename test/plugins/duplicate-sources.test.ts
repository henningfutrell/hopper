// Duplicate job sources (issue #1264): two GitHub sources that take the same issues through the same account or app,
// over repositories that overlap, are duplicates. A second is refused; one already configured is named as a duplicate
// of the first.
import { describe, expect, it } from 'vitest';
import type { ConfiguredInstance, InstanceSpec } from '../../src/domain/types.ts';
import { duplicateJobSource, duplicateJobSources } from '../../src/plugins/duplicates.ts';
import { githubAccountPlugin } from '../../src/plugins/job-source/github-account/index.ts';
import { githubAppPlugin } from '../../src/plugins/job-source/github-app/index.ts';
import type { PluginDefinition } from '../../src/plugins/sdk.ts';

const DEFS: Record<string, PluginDefinition> = { 'github-account': githubAccountPlugin(), 'github-app': githubAppPlugin() };
const find = (id: string) => DEFS[id];
const source = (name: string, plugin: string, options: Record<string, unknown> = {}): ConfiguredInstance =>
  ({ role: 'job-source', instance: { name, plugin, options } });
const spec = (c: ConfiguredInstance): InstanceSpec => c.instance;

describe('duplicate job sources (issue #1264)', () => {
  it('a second connected-account source is a duplicate of the first', () => {
    const configured = [source('github-account', 'github-account')];
    expect(duplicateJobSource(spec(source('gh-2', 'github-account')), configured, find)).toBe('github-account');
  });

  it('a source that takes other issues (another label or hopper name), or is off, is no duplicate', () => {
    const configured = [source('github-account', 'github-account')];
    expect(duplicateJobSource(spec(source('gh-2', 'github-account', { label: 'other' })), configured, find)).toBeUndefined();
    expect(duplicateJobSource(spec(source('gh-2', 'github-account', { hopperName: 'two' })), configured, find)).toBeUndefined();
    expect(duplicateJobSource(spec(source('gh-2', 'github-account', { enabled: false })), configured, find)).toBeUndefined();
  });

  it('app sources: the same app over repositories that overlap is a duplicate; another app or no shared repository is not', () => {
    const configured = [source('github-app', 'github-app', { appId: 1, slug: 'a', repos: ['o/one', 'o/two'] })];
    const check = (options: Record<string, unknown>) => duplicateJobSource(spec(source('app-2', 'github-app', options)), configured, find);
    expect(check({ appId: 1, slug: 'a', repos: ['o/two'] })).toBe('github-app');
    expect(check({ appId: 1, slug: 'a' })).toBe('github-app'); // no repos: every repository the app is installed on
    expect(check({ appId: 1, slug: 'a', repos: ['o/three'] })).toBeUndefined();
    expect(check({ appId: 2, slug: 'b', repos: ['o/two'] })).toBeUndefined();
  });

  it('the instance itself is never its own duplicate', () => {
    const configured = [source('github-account', 'github-account')];
    expect(duplicateJobSource(spec(configured[0]!), configured, find)).toBeUndefined();
  });

  it('of the instances configured, each later duplicate names the first', () => {
    const configured = [source('github-account', 'github-account'), source('gh-2', 'github-account'), source('gh-3', 'github-account'), source('github-app', 'github-app', { appId: 1, slug: 'a' })];
    expect([...duplicateJobSources(configured, find)]).toEqual([['gh-2', 'github-account'], ['gh-3', 'github-account']]);
  });
});
