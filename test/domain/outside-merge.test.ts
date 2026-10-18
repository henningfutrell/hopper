// Yolo mode on a repository the hopper does not work on (issue #1806 part 3): a job may open a pull request on any
// repository its user can push to, and the hopper follows it there; it merges it only when a person named that
// repository on in yolo mode. `on` covers the job repositories only, and so do the kinds merged with no person. Pure.
import { describe, expect, it } from 'vitest';
import { CHANGE_KINDS, DEFAULT_CHANGE_RULE, mergeRuleFor, mergesOnReady, yoloModeFor, type YoloModeSettings } from '../../src/domain/types.ts';

const JOB_REPOS = ['acme/api'];

describe('yolo mode on a repository the hopper does not work on (issue #1806)', () => {
  it('on covers every job repository, and a repository\'s own setting wins', () => {
    expect(yoloModeFor({ on: true, repos: {} }, 'Acme/API', JOB_REPOS)).toBe(true);
    expect(yoloModeFor({ on: true, repos: { 'acme/api': false } }, 'acme/api', JOB_REPOS)).toBe(false);
    expect(yoloModeFor({ on: false, repos: { 'acme/api': true } }, 'acme/api', JOB_REPOS)).toBe(true);
  });

  it('on does not reach another repository: only a person naming it on does', () => {
    expect(yoloModeFor({ on: true, repos: {} }, 'zed/tool', JOB_REPOS)).toBe(false);
    expect(yoloModeFor({ on: false, repos: { 'zed/tool': true } }, 'Zed/Tool', JOB_REPOS)).toBe(true);
    expect(yoloModeFor({ on: true, repos: { 'zed/tool': false } }, 'zed/tool', JOB_REPOS)).toBe(false);
  });

  it('a job repository keeps its change rule: docs merge with no person', () => {
    const rule = mergeRuleFor({ on: false, repos: {} }, 'acme/api', JOB_REPOS);
    expect(rule).toEqual(DEFAULT_CHANGE_RULE);
    expect(mergesOnReady(rule, false, 'docs')).toBe(true);
  });

  it('another repository not named on: no kind is merged with no person, each waits for yolo mode', () => {
    for (const s of [{ on: true, repos: {} }, { on: true, repos: { 'zed/tool': false } }] as YoloModeSettings[]) {
      const rule = mergeRuleFor(s, 'zed/tool', JOB_REPOS);
      for (const kind of CHANGE_KINDS) expect(rule.merge[kind]).toBe('yolo');
      for (const kind of [...CHANGE_KINDS, undefined]) expect(mergesOnReady(rule, yoloModeFor(s, 'zed/tool', JOB_REPOS), kind)).toBe(false);
    }
  });

  it('another repository named on: its change rule as for a job repository', () => {
    const s = { on: false, repos: { 'zed/tool': true } };
    expect(mergeRuleFor(s, 'zed/tool', JOB_REPOS)).toEqual(DEFAULT_CHANGE_RULE);
    expect(mergesOnReady(mergeRuleFor(s, 'zed/tool', JOB_REPOS), yoloModeFor(s, 'zed/tool', JOB_REPOS), 'code')).toBe(true);
  });

  it('a GitLab project, asked by its URL, is no GitHub repository: on still covers it', () => {
    expect(yoloModeFor({ on: true, repos: {} }, 'https://gitlab.example/group/app', [])).toBe(true);
    expect(mergeRuleFor({ on: true, repos: {} }, 'https://gitlab.example/group/app', [])).toEqual(DEFAULT_CHANGE_RULE);
  });
});
