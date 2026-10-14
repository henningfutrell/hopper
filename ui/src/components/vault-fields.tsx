// The Vault page's form fields (issue #558), shared by its secrets and the credentials jobs ask for (issue #583).
import { Input } from '@/components/ui/input';

export function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-muted-foreground">{children}</div>;
}

/** A write-only value: never filled in from the hopper, never remembered by the browser. */
export function ValueInput({ value, onChange, required = true }: { value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <Input className="h-9 font-mono text-sm" type="password" value={value} required={required} maxLength={65536}
      autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
  );
}
