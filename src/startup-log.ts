// The daemon's startup lines: where it listens, what runs each part, how people sign in.
import type { PluginsView } from './domain/ports.ts';
import type { App } from './main.ts';

function unavailableNote(plugins: PluginsView): string {
  const down = plugins.report().executors.instances.filter((i) => i.active === null).map((i) => i.instance.name);
  return down.length ? ` (unavailable, jobs held: ${down.join(',')})` : '';
}

export function logStartup(app: App): void {
  const r = app.plugins.routerStatus();
  const { answerer, assessor } = app.plugins.report();
  const q = `answerer ${answerer.instance ? `${answerer.instance.name} [${answerer.active ?? 'unavailable'}]` : 'none'}, assessor ${assessor.instance?.name} [${assessor.active}${assessor.fallback ? ', fallback' : ''}]`;
  const lan = app.config.lanNames.length ? ` and ${app.config.lanNames.map((n) => `http://${n}:${new URL(app.url).port}`).join(', ')} (LAN peers ${app.config.lanPeers.join(', ')})` : '';
  console.log(`hopper listening on ${app.url}${lan} (router ${r.name} [${r.plugin}${r.fallback ? ', fallback' : ''}] ${app.routerMode()}, executors ${app.engine.executorNames.join(',') || 'none'}${unavailableNote(app.plugins)}, ${q})`);
  for (const s of app.sources.statuses()) console.log(`hopper: source ${s.name} (${s.kind}) ${s.state}`);
  const { auth } = app;
  if (app.config.publicUrl) console.log(`hopper: public URL ${app.config.publicUrl} (sign-in origin)`);
  if (auth.providers.length) console.log(`hopper: sign-in with ${auth.providers.map((p) => `${p.name} (${p.type})`).join(', ')}`);
  if (auth.local.enabled) console.log('hopper: local sign-in on; a login code: hopper login-code');
  else console.log('hopper: local sign-in is off (auth.yaml)');
  if (auth.password) console.log(`hopper: password sign-in on (${auth.password.users.length} account(s))`);
  if (auth.none) console.warn(`hopper: NO SIGN-IN is on (auth.yaml none): anyone who reaches the UI acts as ${auth.none.role}`);
}
