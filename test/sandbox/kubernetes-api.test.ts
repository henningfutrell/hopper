// Issue #1286: how the Kubernetes API's exec says a command ended (a V1Status on its error channel), read as an exit code.
//
// Feature: the exit code of a command run through exec
//   Scenario: success is 0
//   Scenario: a non-zero exit is its code
//   Scenario: any other failure is an error
import { describe, expect, it } from 'vitest';
import { exitOf } from '../../src/sandbox/kubernetes-api.ts';

describe('the exit code of a command run through exec', () => {
  it('success is 0', () => {
    expect(exitOf({ status: 'Success' })).toBe(0);
  });

  it('a non-zero exit is its code', () => {
    expect(exitOf({ status: 'Failure', reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: '42' }] } })).toBe(42);
  });

  it('any other failure is an error', () => {
    expect(() => exitOf({ status: 'Failure', reason: 'InternalError', message: 'container not found ("box")' })).toThrow(/container not found/);
    expect(() => exitOf(undefined)).toThrow(/no status/);
  });
});
