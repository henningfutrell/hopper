// `~` and `~/…` in a plugin option that names a path, resolved against the user's home.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
