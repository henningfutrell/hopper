// A terraform workspace's state backend on Vault (issue #715, part 6): in a template's form, the bucket, region
// and key prefix of each terraform-workspace profile — the read-only check pushes a state of its own to a key of its own
// there, and the account must refuse it —; in the template's facts, each one, or that it has none.
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/vault-fields';
import { backendText } from '@/model/vault';
import type { OperationProfile, TemplateView } from '@/model/wire';

type Draft = { bucket: string; region: string; keyPrefix: string };
const isWorkspace = (p: OperationProfile): boolean => p.asset.kind === 'terraform-workspace';

/** The profiles with each workspace's backend from its draft: none while its bucket is empty. */
function withDrafts(profiles: OperationProfile[], drafts: Record<string, Draft>): OperationProfile[] {
  return profiles.map((p) => {
    const d = isWorkspace(p) ? drafts[p.asset.name] : undefined;
    if (!d) return p;
    const { backend: _, ...rest } = p;
    const keyPrefix = d.keyPrefix.trim().replace(/^\/+|\/+$/g, '');
    return d.bucket.trim() ? { ...rest, backend: { bucket: d.bucket.trim(), region: d.region.trim(), ...(keyPrefix ? { keyPrefix } : {}) } } : rest;
  });
}

/** The state backend of each terraform-workspace profile, in a template's form. */
export function BackendsInput({ profiles, busy, onChange }: { profiles: OperationProfile[]; busy: boolean; onChange: (p: OperationProfile[]) => void }) {
  const workspaces = profiles.filter(isWorkspace);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(workspaces.map((p) => [p.asset.name, {
    bucket: p.backend?.bucket ?? '', region: p.backend?.region ?? '', keyPrefix: p.backend?.keyPrefix ?? '',
  }])));
  if (workspaces.length === 0) return null;
  const set = (name: string, key: keyof Draft, value: string) => {
    const next = { ...drafts, [name]: { ...(drafts[name] ?? { bucket: '', region: '', keyPrefix: '' }), [key]: value } };
    setDrafts(next);
    onChange(withDrafts(profiles, next));
  };
  const input = (name: string, key: keyof Draft, label: string, placeholder: string) => (
    <Input aria-label={`${label} of ${name}`} className="h-8 w-40 font-mono text-xs" value={drafts[name]?.[key] ?? ''} placeholder={placeholder} maxLength={200} disabled={busy}
      autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => set(name, key, e.target.value)} />
  );
  return (
    <div className="space-y-1"><Label>State backend of each terraform workspace — the read-only check pushes a state of its own there, which must be refused</Label>
      {workspaces.map((p) => (
        <div key={p.asset.name} className="flex flex-wrap items-center gap-2">
          <span className="w-32 truncate font-mono text-xs">{p.asset.name}</span>
          {input(p.asset.name, 'bucket', 'State bucket', 'bucket')}
          {input(p.asset.name, 'region', 'State region', 'eu-west-1')}
          {input(p.asset.name, 'keyPrefix', 'State key prefix', 'key prefix (optional)')}
        </div>
      ))}
    </div>
  );
}

/** The template's state backends in its facts; nothing for a template with no terraform workspace. */
export function BackendRows({ t }: { t: TemplateView }) {
  const lines = t.profiles.filter(isWorkspace).map(backendText);
  if (lines.length === 0) return null;
  return <><dt className="text-muted-foreground">State backend</dt><dd className="break-words">{lines.map((l) => <div key={l} className={l.includes('no state backend') ? 'text-warn' : ''}>{l}</div>)}</dd></>;
}
