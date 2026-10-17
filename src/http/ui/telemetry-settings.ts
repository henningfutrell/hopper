// Telemetry in Settings (issue #1486, design.md "Telemetry settings"): Settings → Telemetry, the hopper's admin's.
// GET /api/telemetry-settings shows the setting, where the telemetry's config comes from now and whether it exports;
// POST /ui/api/telemetry-settings keeps the whole setting, from the UI or with an API token, never from a file. It applies
// at once, while the launch's OTEL_* variables name no exporter.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TELEMETRY_SIGNALS, telemetrySettingsProblem, type TelemetrySettingsView } from '../../domain/telemetry-settings.ts';
import type { TelemetrySettingsService } from '../../telemetry/settings.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The whole setting. */
export const telemetrySettingsBody = z.strictObject({ on: z.boolean(), endpoint: z.string().max(500), signals: z.array(z.enum(TELEMETRY_SIGNALS)).max(TELEMETRY_SIGNALS.length) })
  .superRefine((b, ctx) => {
    const problem = telemetrySettingsProblem(b);
    if (problem) ctx.addIssue({ code: 'custom', path: ['endpoint'], message: problem });
  });

export const TELEMETRY_SETTINGS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/telemetry-settings', tag: 'Machines and usage', summary: 'The telemetry setting', description: 'Only the instance admin (issue #1486). `settings`: whether the hopper exports its traces, metrics and logs over OTLP, the endpoint and the signals; `source`: where the telemetry\'s config comes from now — `launch` (the launch\'s OTEL_* variables name an exporter: they win, and the setting is only kept), `settings`, or `off`; `exporting`: whether it exports now; `protocol`: the setting\'s OTLP protocol, `http/protobuf`.', returns: '`TelemetrySettingsView`', errors: [403] },
  { method: 'post', path: '/ui/api/telemetry-settings', tag: 'Machines and usage', summary: 'Set the telemetry setting', description: 'Only the instance admin (issue #1486). The whole setting: `on`; `endpoint`, the OTLP base URL (http or https, no user, password, query or fragment; each signal goes to `<endpoint>/v1/<signal>`), needed when on; `signals`, any of `traces`, `metrics`, `logs`, at least one when on. A header the collector needs is given at launch (`OTEL_EXPORTER_OTLP_HEADERS`), never here. Applies at once, without a restart: the export running is flushed and stopped, and one is started from the setting. A change is `telemetry.changed`.', role: 'admin', body: telemetrySettingsBody, returns: '`TelemetrySettingsView`', errors: [400, 403] },
];

export function registerTelemetrySettingsRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; telemetrySettings: TelemetrySettingsService; by: (req: FastifyRequest) => string }): void {
  app.get('/api/telemetry-settings', async (req): Promise<TelemetrySettingsView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the telemetry setting');
    return o.telemetrySettings.view();
  });
  app.post('/ui/api/telemetry-settings', o.instance, async (req): Promise<TelemetrySettingsView> => {
    return o.telemetrySettings.change(parseWith(telemetrySettingsBody, req.body), o.by(req));
  });
}
