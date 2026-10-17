// The telemetry setting (issue #1486, design.md "Telemetry settings"), pure: which OTLP endpoint is one, and the record as
// it is kept.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TELEMETRY_SETTINGS, telemetryEndpointProblem, telemetryRecord, telemetrySettingsProblem } from '../../src/domain/telemetry-settings.ts';

describe('the telemetry setting (issue #1486)', () => {
  it('takes an http or https URL, with a path, and no user, password, query or fragment', () => {
    for (const ok of ['http://collector:4318', 'https://otlp.example.net/otlp', 'http://127.0.0.1:4318/']) expect(telemetryEndpointProblem(ok), ok).toBeUndefined();
    for (const bad of ['', 'collector:4318', 'ftp://collector', 'http://user:pw@collector:4318', 'http://collector:4318?token=x', 'http://collector:4318#x', 'http://']) {
      expect(telemetryEndpointProblem(bad), bad).toBeDefined();
    }
  });

  it('is off by default, with every signal', () => {
    expect(DEFAULT_TELEMETRY_SETTINGS).toEqual({ on: false, endpoint: '', signals: ['traces', 'metrics', 'logs'] });
  });

  it('on, needs an endpoint and a signal; off, may keep none', () => {
    expect(telemetrySettingsProblem({ on: true, endpoint: '', signals: ['traces'] })).toMatch(/endpoint/);
    expect(telemetrySettingsProblem({ on: true, endpoint: 'http://collector:4318', signals: [] })).toMatch(/signal/);
    expect(telemetrySettingsProblem({ on: true, endpoint: 'http://collector:4318', signals: ['logs'] })).toBeUndefined();
    expect(telemetrySettingsProblem({ on: false, endpoint: '', signals: [] })).toBeUndefined();
    expect(telemetrySettingsProblem({ on: false, endpoint: 'http://a:b@collector', signals: [] })).toMatch(/user/);
  });

  it('keeps the endpoint trimmed with no trailing slash, and the signals in their order, each once', () => {
    expect(telemetryRecord({ on: true, endpoint: ' http://collector:4318/ ', signals: ['logs', 'traces', 'logs'] }))
      .toEqual({ on: true, endpoint: 'http://collector:4318', signals: ['traces', 'logs'] });
  });
});
