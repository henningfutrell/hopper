// The daemon's startup lines: where it listens, what runs each part, how people sign in.
import type { PluginsView } from './domain/ports.ts';
import type { App } from './main.ts';

function unavailableNote(plugins: PluginsView): string {
  const down = plugins.report().executors.instances.filter((i) => i.active === null).map((i) => i.instance.name);
  return down.length ? ` (unavailable, jobs held: ${down.join(',')})` : '';
}

export function logStartup(app: App): void {
  const lan = app.config.lanNames.length ? ` and ${app.config.lanNames.map((n) => `http://${n}:${new URL(app.url).port}`).join(', ')} (LAN peers ${app.config.lanPeers.join(', ')})` : '';
  const users = app.users();
  console.log(`hopper listening on ${app.url}${lan} (${users.length} user${users.length === 1 ? '' : 's'})`);
  // One line per user (issue #158): each user's parts are their own.
  for (const u of users) {
    const rt = app.user(u.id);
    const r = rt.plugins.routerStatus();
    const levels = rt.plugins.report().escalationLevels.map((l) => `${l.instance.name} [${l.active ?? 'unavailable'}]`);
    const q = `escalation levels ${levels.length ? levels.join(' → ') : 'none'} → owner`;
    console.log(`hopper: user ${u.id}: router ${r.name} [${r.plugin}${r.fallback ? ', fallback' : ''}] ${rt.routerMode()}, executors ${rt.engine.executorNames.join(',') || 'none'}${unavailableNote(rt.plugins)}, ${q}`);
    for (const s of rt.registry.statuses()) console.log(`hopper: user ${u.id}: source ${s.name} (${s.kind}) ${s.state}`);
  }
  const { auth } = app;
  if (app.config.publicUrl) console.log(`hopper: public URL ${app.config.publicUrl} (sign-in origin)`);
  if (auth.providers.length) console.log(`hopper: sign-in with ${auth.providers.map((p) => `${p.name} (${p.type})`).join(', ')}`);
  if (auth.local.enabled) console.log('hopper: local sign-in on; a login code: hopper login-code');
  else console.log('hopper: local sign-in is off (auth.yaml)');
  if (auth.password) console.log(`hopper: password sign-in on (${auth.password.users.length} account(s))`);
  if (auth.none) console.warn(`hopper: NO SIGN-IN is on (auth.yaml none): anyone who reaches the UI acts as ${auth.none.role}`);
}
