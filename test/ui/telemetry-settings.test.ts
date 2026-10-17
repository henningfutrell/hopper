// Telemetry in Settings, in the UI (ui/src/model/telemetry-settings.ts, issue #1486), pure: the line that says where the
// telemetry's config comes from, and a signal ticked or not.
import { describe, expect, it } from 'vitest';
import { telemetrySourceLine, toggleSignal } from '../../ui/src/model/telemetry-settings.ts';

const settings = { on: true, endpoint: 'http://collector:4318', signals: ['traces' as const] };

describe('telemetry in Settings, in the UI (issue #1486)', () => {
  it('says the launch wins, the setting exports, or nothing is exported', () => {
    expect(telemetrySourceLine({ settings, source: 'launch', exporting: true, protocol: 'http/protobuf' })).toMatch(/^The launch's OTEL_\* variables/);
    expect(telemetrySourceLine({ settings, source: 'settings', exporting: true, protocol: 'http/protobuf' })).toBe('Exporting traces to http://collector:4318 (OTLP, HTTP and protobuf).');
    expect(telemetrySourceLine({ settings: { ...settings, on: false }, source: 'off', exporting: false, protocol: 'http/protobuf' })).toBe('Off: nothing is exported.');
  });

  it('ticks a signal on or off, keeping their order', () => {
    expect(toggleSignal(['logs'], 'traces', true)).toEqual(['traces', 'logs']);
    expect(toggleSignal(['traces', 'logs'], 'traces', false)).toEqual(['logs']);
  });
});
