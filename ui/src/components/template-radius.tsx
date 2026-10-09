// A template's blast radius (issue #584), as Settings → Vault and Settings → Access show it next to the template: its
// level, then the reasons that set it — its operation profiles, approved or waiting, and its vault secrets.
import { StatusBadge } from '@/components/status';
import { levelTone } from '@/model/blast-radius';
import type { TemplateRadius } from '@/model/wire';

export function TemplateRadiusBadge({ radius }: { radius: TemplateRadius }) {
  return <StatusBadge status={radius.level} tone={levelTone(radius.level)} label={`${radius.level} radius`} title={radius.reasons.join('\n')} />;
}

export function TemplateRadiusReasons({ radius }: { radius: TemplateRadius }) {
  return (
    <ul data-slot="template-radius" data-level={radius.level} className="list-disc space-y-0.5 pl-4 text-xs break-words text-muted-foreground">
      {radius.reasons.map((r) => <li key={r}>{r}</li>)}
    </ul>
  );
}
