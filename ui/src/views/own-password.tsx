// Your password (issue #221): the password account this session signed in with takes a new password,
// the current one checked first (POST /ui/api/password); every other session of the account ends. A
// password an admin handed over stops being one the admin knows.
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { post, SessionRejected } from '@/lib/api';
import { useHopper } from '@/store';

export function OwnPassword() {
  const realm = useHopper((s) => s.user?.realm);
  const password = useHopper((s) => s.signIn?.password ?? false);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  if (!password || realm === undefined || realm === 'local' || realm === 'none') return null;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post('/ui/api/password', { current, password: next });
      toast.success('Password changed. Your other sessions are signed out.');
      setOpen(false);
      setCurrent('');
      setNext('');
    } catch (err) {
      if (err instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return <Button size="xs" variant="outline" onClick={() => setOpen(true)}>Change your password</Button>;
  return (
    <form data-own-password className="flex flex-wrap items-end gap-2 rounded-lg border p-3" onSubmit={(e) => void save(e)}>
      <Input aria-label="Current password" type="password" placeholder="current password" className="w-44" autoComplete="current-password"
        value={current} disabled={busy} onChange={(e) => setCurrent(e.target.value)} />
      <Input aria-label="New password" type="password" placeholder="new password (8 or more)" className="w-52" autoComplete="new-password"
        value={next} disabled={busy} onChange={(e) => setNext(e.target.value)} />
      <Button type="submit" size="sm" disabled={busy || current === '' || next.length < 8}>Change</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}
