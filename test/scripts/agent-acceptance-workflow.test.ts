// Issue #1958, part 3: the CI run of the acceptance tests of the agent CLIs (test/acceptance/). On a pull request that
// changes the executors or the tests themselves, and nightly, the real print-mode CLIs are installed on the runner and
// their acceptance tests run against the fake model server. A CLI that is not installed fails the run: each test finds
// its CLI by HOPPER_ACCEPTANCE_<AGENT>_BIN, never by a skip. Nightly only, the real Claude Code TUI runs in a real herdr
// pane (HOPPER_ACCEPTANCE_TUI=1), and its captures are kept as artifacts, also when the check fails. Read-only and with
// no secrets: `pull_request`, never `pull_request_target`; the CLIs get a dummy key and reach only the fake server.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REAL_AGENTS } from '../support/real-agents.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FILE = join(ROOT, '.github', 'workflows', 'agent-acceptance.yml');

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { if?: string; 'timeout-minutes'?: number; steps: Step[] };
type Workflow = {
  name: string;
  on: { schedule?: { cron: string }[]; workflow_dispatch?: null; pull_request?: { branches: string[]; paths: string[] } };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const text = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
const workflow = (text ? parse(text) : { on: {}, jobs: {} }) as Workflow;
const runs = (job: string): string => (workflow.jobs[job]?.steps ?? []).map((s) => s.run ?? '').join('\n');

describe('.github/workflows/agent-acceptance.yml, the acceptance tests of the agent CLIs', () => {
  it('runs nightly, by hand, and on a pull request that changes the executors or the acceptance tests', () => {
    expect(workflow.name).toBe('agent-acceptance');
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on.pull_request?.branches).toEqual(['main', 'dev', 'beta', 'stable']);
    expect(workflow.on.pull_request?.paths).toEqual(expect.arrayContaining([
      'src/executors/**', 'test/acceptance/**', 'test/adapters/fake-print-agent.mjs', 'test/support/real-agents.ts',
      'test/support/fake-model-*.ts', 'test/support/fake-mcp-server.ts', 'test/support/screen-drift.ts',
      '.github/workflows/agent-acceptance.yml',
    ]));
  });

  it('reads the repository only, and names no secret', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\./);
    for (const [name, job] of Object.entries(workflow.jobs)) expect(job['timeout-minutes'], name).toBeLessThanOrEqual(30);
  });

  it('installs every print-mode CLI the tests know, and fails when one is not there', () => {
    const job = workflow.jobs['print-agents'];
    expect(job).toBeDefined();
    const mise = job!.steps.find((s) => s.uses?.startsWith('jdx/mise-action@'));
    for (const a of REAL_AGENTS) {
      expect(String(mise?.with?.mise_toml), a.agent).toMatch(new RegExp(`\\b${a.agent === 'omp' ? 'oh-my-pi' : a.agent}\\b`));
      expect(runs('print-agents'), a.agent).toMatch(new RegExp(`\\b${a.agent}\\b`));
    }
    // The bin variable, not PATH: realBin() names it first, and a CLI with no bin fails the step, so its tests never skip.
    expect(runs('print-agents')).toContain('HOPPER_ACCEPTANCE_${cli^^}_BIN=$bin');
    expect(runs('print-agents')).toMatch(/bin=\$\(mise which "\$cli"\)/);
  });

  it('runs the print-mode CLIs, the drift check, hooks and MCP and the opencode draft, but not the TUI', () => {
    const test = workflow.jobs['print-agents']!.steps.find((s) => s.run?.startsWith('npx vitest run'));
    expect(test?.run).toBe('npx vitest run test/acceptance/print-agents.test.ts test/acceptance/fake-drift.test.ts test/acceptance/hooks-mcp.test.ts test/acceptance/draft-opencode.test.ts');
    expect(JSON.stringify(workflow.jobs['print-agents'])).not.toContain('HOPPER_ACCEPTANCE_TUI');
  });

  it('runs the TUI nightly or by hand only, and keeps its captures as artifacts when it fails too', () => {
    const job = workflow.jobs.tui;
    expect(job?.if).toBe("github.event_name != 'pull_request'");
    const test = job!.steps.find((s) => s.run === 'npx vitest run test/acceptance/tui-screens.test.ts');
    expect(test?.env).toMatchObject({ HOPPER_ACCEPTANCE_TUI: '1', HOPPER_ACCEPTANCE_TUI_OUT: '${{ runner.temp }}/tui-screens' });
    expect(runs('tui')).toContain('https://herdr.dev/install.sh');
    expect(runs('tui')).toContain('HOPPER_ACCEPTANCE_CLAUDE_BIN=');
    const upload = job!.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('always()');
    expect(upload?.with).toMatchObject({ path: '${{ runner.temp }}/tui-screens' });
  });
});
