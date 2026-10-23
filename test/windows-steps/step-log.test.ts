// Issue #2690: a Windows step whose output held NUL bytes ended the hopper. wsl.exe writes UTF-16LE text, so every other
// byte is NUL; Postgres keeps no NUL in a text column (22021), and the append's error, thrown in the handler of the ssh
// stream, was caught nowhere. The steps' logs keep such output readable, and a log the database does not keep is the
// step's problem, never the hopper's end. The real database; a double at the Windows host that writes its log from a
// timer, as the ssh stream's handler does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import type { WindowsHost, WindowsStepHost, WindowsStepRepository } from '../../src/domain/windows-steps.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { createWindowsSteps, STEP_LOG_LOST } from '../../src/windows-steps/index.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const temp = useTempStore();
const HOST: WindowsHost = { name: 'build-host', ssh: 'builder@winbox', hostKey: 'ssh-ed25519 AAAA', workDir: 'C:\\work\\app' };
const JOB = { id: 'job-1', status: 'running' } as unknown as Job;
/** What the ssh stream gives the log of `wsl.exe -l -q`: UTF-16LE bytes read as UTF-8. */
const WSL = Buffer.from('Ubuntu-24.04\r\ndocker-desktop\r\n', 'utf16le').toString('utf8');

/** A host whose step writes `chunks` to its log from timers, as the ssh stream's handler does, then exits 0. */
const host = (chunks: string[]): WindowsStepHost => ({
  run: (_h, _step, io) => new Promise((resolve) => {
    let n = 0;
    const next = () => {
      if (n === chunks.length) { resolve({ exit: 0 }); return; }
      io.log(chunks[n++]!);
      setTimeout(next, 1);
    };
    setTimeout(next, 1);
  }),
  sweep: async () => {},
});

describe('a step log with NUL bytes (issue #2690)', () => {
  const stores: InstanceStore[] = [], dirs: string[] = [];
  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const open = (): InstanceStore => {
    const store = openInstanceStore({ url: temp.url(), clock: fixedClock() });
    stores.push(store);
    return store;
  };
  /** Runs one step on `h` to its end: its state and its log. */
  const runStep = async (store: InstanceStore, h: WindowsStepHost, repo: WindowsStepRepository = store.windowsSteps) => {
    const dir = mkdtempSync(join(tmpdir(), 'win-log-'));
    dirs.push(dir);
    const logged: string[] = [];
    const steps = createWindowsSteps({
      userId: 'admin', hosts: () => [HOST], host: h, steps: repo, atWork: () => true, dir, record: () => {}, log: (l) => logged.push(l),
      sagas: { begin: () => 'saga-1', abort: () => false },
    });
    const r = steps.start(JOB, { host: HOST.name, command: 'wsl.exe -l -q', outputs: [] }, { key: 'key-0001', inputs: Buffer.alloc(0) });
    if ('no' in r) throw new Error(r.no);
    await steps.run(r.id, new AbortController().signal);
    return { state: steps.state(JOB, r.id), log: steps.log(JOB, r.id, 0)?.text, logged };
  };

  it('a Windows step\'s log keeps UTF-16LE output readable, and the step ends as it ran', async () => {
    const store = open();
    const { state, log } = await runStep(store, host(['before\r\n', WSL, 'nul\0 in the middle\r\n']));
    expect(state).toEqual({ result: { exit: 0 } });
    expect(log).toBe('before\r\nUbuntu-24.04\r\ndocker-desktop\r\nnul in the middle\r\n');
  });

  it('a need step\'s log keeps NUL bytes out too', () => {
    const store = open();
    const step = store.needSteps.add({
      id: 'need-1', userId: 'admin', jobId: JOB.id, key: 'key-0001', box: 'hopper-need-1', template: { name: 't' } as never, needs: [],
      command: 'find . -print0', timeoutSeconds: 60, outputs: [], inputsBytes: 0, createdAt: '2026-10-23T00:00:00.000Z',
    }, Buffer.alloc(0));
    store.needSteps.appendLog(step.id, './a\0./b\0');
    expect(store.needSteps.log(step.id, 0).text).toBe('./a./b');
  });

  it('a log the database does not keep is the step\'s problem: nothing escapes, and the step still ends', async () => {
    const store = open();
    const repo: WindowsStepRepository = { ...store.windowsSteps, appendLog: () => { throw new Error('invalid byte sequence for encoding "UTF8": 0x00'); } };
    const { state, logged } = await runStep(store, host(['one\r\n', 'two\r\n']), repo);
    expect(state).toEqual({ result: { exit: 0, problem: `${STEP_LOG_LOST}: invalid byte sequence for encoding "UTF8": 0x00` } });
    // Said once, not at each chunk.
    expect(logged.filter((l) => l.includes('invalid byte sequence'))).toHaveLength(1);
  });
});
