import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

describe('configuration from env', () => {
  it('uses the documented defaults on an empty environment', () => {
    const c = loadConfig({});
    expect(c).toEqual({
      host: '127.0.0.1',
      port: 4790,
      dbPath: join(homedir(), '.local/share/job-hopper/job-hopper.db'),
      tickMs: 2000,
      jevMode: 'shadow',
      jevAdvisor: 'router',
      jevSrc: join(homedir(), 'workbench/jev-src/grok-bot-jev'),
      python: 'python3',
      localLanes: 4,
      softLimit: 0.7,
      hardLimit: 0.95,
      jevCheapBoost: 10,
      webhookBaseMs: 1000,
      laneIdleGraceMs: 5000,
    });
  });

  it('reads every variable and expands ~', () => {
    const c = loadConfig({
      JOB_HOPPER_HOST: '127.0.0.1', JOB_HOPPER_PORT: '0', JOB_HOPPER_DB: '~/x/db.sqlite',
      JOB_HOPPER_TICK_MS: '50', JOB_HOPPER_JEV_MODE: 'active', JOB_HOPPER_JEV_ADVISOR: 'fake',
      JOB_HOPPER_JEV_SRC: '~/jev', JOB_HOPPER_PYTHON: '/usr/bin/python3', JOB_HOPPER_LOCAL_LANES: '2',
      JOB_HOPPER_SOFT_LIMIT: '0.5', JOB_HOPPER_HARD_LIMIT: '0.9', JOB_HOPPER_JEV_CHEAP_BOOST: '5',
      JOB_HOPPER_WEBHOOK_BASE_MS: '20', JOB_HOPPER_LANE_IDLE_GRACE_MS: '100',
    });
    expect(c.dbPath).toBe(join(homedir(), 'x/db.sqlite'));
    expect(c.jevSrc).toBe(join(homedir(), 'jev'));
    expect(c).toMatchObject({
      port: 0, tickMs: 50, jevMode: 'active', jevAdvisor: 'fake', python: '/usr/bin/python3',
      localLanes: 2, softLimit: 0.5, hardLimit: 0.9, jevCheapBoost: 5, webhookBaseMs: 20, laneIdleGraceMs: 100,
    });
  });

  it.each([
    ['JOB_HOPPER_PORT', 'abc'],
    ['JOB_HOPPER_PORT', '70000'],
    ['JOB_HOPPER_TICK_MS', '0'],
    ['JOB_HOPPER_JEV_MODE', 'loud'],
    ['JOB_HOPPER_JEV_ADVISOR', 'magic'],
    ['JOB_HOPPER_LOCAL_LANES', '-1'],
    ['JOB_HOPPER_SOFT_LIMIT', '1.5'],
    ['JOB_HOPPER_HOST', '0.0.0.0'],
  ])('fails loudly on %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('refuses a soft limit at or above the hard limit', () => {
    expect(() => loadConfig({ JOB_HOPPER_SOFT_LIMIT: '0.9', JOB_HOPPER_HARD_LIMIT: '0.8' })).toThrow('SOFT_LIMIT');
  });
});
