// node scripts/copy-artifact-libs.ts <ui dist dir> — run by `npm run build:ui` after vite (issue #675): copies the diagram
// and chart libraries artifacts load into <dist>/artifact-lib/, where the daemon serves them (src/artifacts/libs.ts).
import { join } from 'node:path';
import { ARTIFACT_LIBS, copyArtifactLibs } from '../src/artifacts/libs.ts';

const [dist] = process.argv.slice(2);
if (!dist) {
  console.error('usage: node scripts/copy-artifact-libs.ts <ui dist dir>');
  process.exit(2);
}
copyArtifactLibs(join(dist, 'artifact-lib'));
console.log(`artifact libraries: ${ARTIFACT_LIBS.map((l) => l.file).join(', ')} in ${join(dist, 'artifact-lib')}`);
