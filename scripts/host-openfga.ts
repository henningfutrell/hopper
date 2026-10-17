// node scripts/host-openfga.ts <config dir> <install dir> <compose.yaml> — called by install.sh (issue #791).
// OpenFGA for a host install, as compose runs it (docs/deploy.md "Access: OpenFGA"): the release binary of the version
// compose.yaml names, its sha256 checked against the release's checksums, in <install dir>/openfga; its tables in the
// `openfga` schema of the hopper's database (HOPPER_DATABASE_URL, or the file HOPPER_DATABASE_URL_FILE names); a
// preshared key and its config in <config dir>/openfga (mode 600: the config holds the database URL); on loopback only.
// It adds HOPPER_OPENFGA_URL and HOPPER_OPENFGA_KEY_FILE to <config dir>/daemon.env. systemd/hopper-openfga.service
// runs it: `openfga migrate`, then `openfga run`, from that dir.
// daemon.env that names another OpenFGA is the operator's own: nothing is done, exit 3.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the hopper reaches the OpenFGA this script sets up. Metrics stay on OpenFGA's own port (2112), on loopback. */
export const HOST_OPENFGA_URL = 'http://127.0.0.1:4793';
const GRPC_ADDR = '127.0.0.1:4794';
const METRICS_ADDR = '127.0.0.1:2112';
const RELEASES = 'https://github.com/openfga/openfga/releases/download';

/** The OpenFGA version compose.yaml runs: one place names it, and a host install follows it. */
export function openFgaVersion(compose: string): string {
  const m = /docker\.io\/openfga\/openfga:v(\d+\.\d+\.\d+)\b/.exec(compose);
  if (!m) throw new Error('compose.yaml names no docker.io/openfga/openfga:v<version> image');
  return m[1]!;
}

/** The release's name for this machine's architecture. */
export function releaseArch(arch: string): string {
  const name = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[arch];
  if (!name) throw new Error(`OpenFGA publishes no linux binary for ${arch}: run one yourself and set HOPPER_OPENFGA_URL (docs/deploy.md "Access: OpenFGA")`);
  return name;
}

/** The sha256 a checksums file (`<hex>  <file>` lines) gives for one file. */
export function checksumOf(checksums: string, file: string): string {
  for (const line of checksums.split('\n')) {
    const [hex, name] = line.trim().split(/\s+/);
    if (name === file && hex && /^[0-9a-f]{64}$/.test(hex)) return hex;
  }
  throw new Error(`the release's checksums name no ${file}`);
}

/** The hopper's database URL with OpenFGA's own schema, as compose gives it. */
export function datastoreUri(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  u.searchParams.set('search_path', 'openfga');
  return u.toString();
}

/** OpenFGA's config.yaml: postgres, the preshared key, every address on loopback, no playground. */
export function openFgaConfig(o: { databaseUrl: string; key: string }): string {
  const q = JSON.stringify;
  return [
    'datastore:', '  engine: postgres', `  uri: ${q(datastoreUri(o.databaseUrl))}`,
    'authn:', '  method: preshared', '  preshared:', `    keys: [${q(o.key)}]`,
    'grpc:', `  addr: ${q(GRPC_ADDR)}`,
    'http:', `  addr: ${q(new URL(HOST_OPENFGA_URL).host)}`,
    'metrics:', '  enabled: true', `  addr: ${q(METRICS_ADDR)}`,
    'playground:', '  enabled: false', '',
  ].join('\n');
}

/** daemon.env's OpenFGA: `ours` (absent, or the one this script sets up), else the operator's own. */
export function openFgaOf(env: string): 'absent' | 'ours' | 'own' {
  const line = env.split('\n').find((l) => l.startsWith('HOPPER_OPENFGA_URL='));
  if (!line) return 'absent';
  return line.slice('HOPPER_OPENFGA_URL='.length).trim() === HOST_OPENFGA_URL ? 'ours' : 'own';
}

export interface HostOpenFga {
  configDir: string; installDir: string; compose: string; databaseUrl: string; arch: string;
  fetch: (url: string) => Promise<Response>;
  /** Extracts the file `openfga` of a .tar.gz into a dir. */
  untar: (tarball: string, dir: string) => void;
  /** Makes the `openfga` schema in the database. */
  schema: (databaseUrl: string) => Promise<void>;
  log: (line: string) => void;
}

async function bytes(f: HostOpenFga['fetch'], url: string): Promise<Buffer> {
  const r = await f(url);
  if (!r.ok) throw new Error(`GET ${url}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Sets OpenFGA up; 'own' when daemon.env names another OpenFGA, and then nothing is done. */
export async function installHostOpenFga(h: HostOpenFga): Promise<'own' | 'installed'> {
  const envFile = join(h.configDir, 'daemon.env');
  const env = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const state = openFgaOf(env);
  if (state === 'own') return 'own';

  const version = openFgaVersion(h.compose);
  const dir = join(h.installDir, 'openfga');
  const binary = join(dir, 'openfga');
  const versionFile = join(dir, 'VERSION');
  if (existsSync(binary) && existsSync(versionFile) && readFileSync(versionFile, 'utf8').trim() === version) {
    h.log(`OpenFGA ${version} is in ${dir}`);
  } else {
    const file = `openfga_${version}_linux_${releaseArch(h.arch)}.tar.gz`;
    h.log(`download OpenFGA ${version} (${file}) and check its sha256`);
    const tarball = await bytes(h.fetch, `${RELEASES}/v${version}/${file}`);
    const checksums = (await bytes(h.fetch, `${RELEASES}/v${version}/checksums.txt`)).toString('utf8');
    const got = createHash('sha256').update(tarball).digest('hex');
    if (got !== checksumOf(checksums, file)) throw new Error(`${file}: sha256 ${got} is not the one the release's checksums give`);
    const work = `${dir}.new`;
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, file), tarball);
    h.untar(join(work, file), work);
    rmSync(join(work, file));
    chmodSync(join(work, 'openfga'), 0o755);
    writeFileSync(join(work, 'VERSION'), `${version}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(work, dir);
  }

  const fga = join(h.configDir, 'openfga');
  mkdirSync(fga, { recursive: true, mode: 0o700 });
  const keyFile = join(fga, 'key');
  if (!existsSync(keyFile) || readFileSync(keyFile, 'utf8').trim() === '') writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const key = readFileSync(keyFile, 'utf8').trim();
  writeFileSync(join(fga, 'config.yaml'), openFgaConfig({ databaseUrl: h.databaseUrl, key }), { mode: 0o600 });
  chmodSync(join(fga, 'config.yaml'), 0o600);
  h.log(`wrote ${join(fga, 'config.yaml')} (mode 600) and its preshared key ${keyFile}`);

  await h.schema(h.databaseUrl);
  h.log('made the openfga schema in the hopper\'s database, if it was not there');

  if (state === 'absent') {
    writeFileSync(envFile, `${env}${env === '' || env.endsWith('\n') ? '' : '\n'}HOPPER_OPENFGA_URL=${HOST_OPENFGA_URL}\nHOPPER_OPENFGA_KEY_FILE=${keyFile}\n`, { mode: 0o600 });
    h.log(`added HOPPER_OPENFGA_URL=${HOST_OPENFGA_URL} and HOPPER_OPENFGA_KEY_FILE to ${envFile}`);
  }
  return 'installed';
}

function databaseUrlOf(env: NodeJS.ProcessEnv): string {
  if (env['HOPPER_DATABASE_URL']) return env['HOPPER_DATABASE_URL'];
  if (env['HOPPER_DATABASE_URL_FILE']) return readFileSync(env['HOPPER_DATABASE_URL_FILE'], 'utf8').trim();
  throw new Error('no HOPPER_DATABASE_URL or HOPPER_DATABASE_URL_FILE');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [configDir, installDir, composeFile] = process.argv.slice(2);
  if (!configDir || !installDir || !composeFile) {
    console.error('usage: node scripts/host-openfga.ts <config dir> <install dir> <compose.yaml>');
    process.exit(2);
  }
  try {
    const r = await installHostOpenFga({
      configDir, installDir, compose: readFileSync(composeFile, 'utf8'), databaseUrl: databaseUrlOf(process.env), arch: process.arch,
      fetch: (url) => fetch(url),
      untar: (tarball, dir) => {
        const t = spawnSync('tar', ['-xzf', tarball, '-C', dir, 'openfga'], { stdio: 'inherit' });
        if (t.status !== 0) throw new Error(`tar -xzf ${tarball}: exit ${t.status}`);
      },
      schema: async (url) => {
        const { default: pg } = await import('pg');
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        try { await client.query('CREATE SCHEMA IF NOT EXISTS openfga'); } finally { await client.end(); }
      },
      log: (line) => console.log(line),
    });
    if (r === 'own') {
      console.log('daemon.env names your own OpenFGA (HOPPER_OPENFGA_URL): none installed');
      process.exit(3);
    }
  } catch (e) {
    console.error(`OpenFGA: ${(e as Error).message}`);
    process.exit(1);
  }
}
