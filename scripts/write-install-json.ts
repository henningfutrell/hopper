// node scripts/write-install-json.ts <file> <install|image> <repo> <branch> <commit> — install.json: what a build
// was made from and when (design.md "Self-update"). Called by scripts/install.sh and by the Dockerfile (issue #409),
// so an install and an image record themselves the same way. A field given empty is left out, never guessed: the
// daemon then says which one the build lacks (src/update/install.ts).
import { writeFileSync } from 'node:fs';

const [file, kind, repo = '', branch = '', commit = ''] = process.argv.slice(2);
if (!file || (kind !== 'install' && kind !== 'image')) {
  console.error('usage: node scripts/write-install-json.ts <file> <install|image> <repo> <branch> <commit>');
  process.exit(2);
}
const fields = Object.fromEntries(Object.entries({ repo, branch, commit }).filter(([, v]) => v !== ''));
writeFileSync(file, `${JSON.stringify({ kind, ...fields, installedAt: new Date().toISOString() }, null, 2)}\n`);
