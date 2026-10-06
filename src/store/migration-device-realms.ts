// Migration 23 (issue #214): a github realm signs in through the hopper's GitHub App by the device flow,
// with its public client id and no secret, and every hopper offers it. A github realm stored for an OAuth
// app of its own keeps its name, label, on/off and role rules; its app settings and client secret go —
// the app is the instance's now (HOPPER_GITHUB_*), and the secret is one the hopper no longer keeps. A
// hopper with no github realm gets one, `github`, after its realms, with no role rules: the first person
// to sign in with GitHub becomes admin (issue #239), and the rules grant everyone after.
import type { Db } from './db.ts';

const APP_SETTINGS = ['clientId', 'clientSecret', 'webUrl', 'apiUrl'];
const GITHUB_REALM = { name: 'github', label: 'GitHub', type: 'github' };

export function githubRealmsThroughTheApp(db: Db): void {
  const row = db.get("SELECT value FROM config WHERE name = 'sign-in'");
  if (!row) return;
  const value = JSON.parse(String(row.value)) as { realms?: unknown };
  const realms = Array.isArray(value.realms) ? value.realms as Record<string, unknown>[] : [];
  const stripped = realms.map((r) => (r.type === 'github' ? Object.fromEntries(Object.entries(r).filter(([k]) => !APP_SETTINGS.includes(k))) : r));
  const taken = new Set(realms.map((r) => r.name));
  const offered = stripped.some((r) => r.type === 'github') || taken.has(GITHUB_REALM.name) ? stripped : [...stripped, GITHUB_REALM];
  db.run("UPDATE config SET value = ? WHERE name = 'sign-in'", JSON.stringify({ ...value, realms: offered }));
}
