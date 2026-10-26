// The Helm chart's optional parts (issue #1282, docs/deploy.md "On Kubernetes, with Helm"): the tunnel services with
// compose.yaml's own scripts, an external Postgres (the vault pod and the local KMS: helm-chart-vault.test.ts), and the OpenFGA migration
// as a Job that an upgrade with the same values runs no second time. In every form the master key reaches a pod only by
// a Secret reference or a mounted Secret, never as a value. Asserted on what `helm template` renders.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { container, env, find, helm, pod, render, type Resource, workloads } from '../support/helm-chart.ts';

const CHART = join(import.meta.dirname, '..', '..', 'deploy', 'helm', 'hopper');
const all = ['postgres.bundled=false', 'postgres.external.existingSecret=hopper-db', 'hopperVault.enabled=true', 'kms.local.enabled=true'];
const policyFrom = (rs: Resource[], name: string): string[] => (find(rs, 'NetworkPolicy', name).spec?.ingress ?? [])
  .flatMap((i) => i.from ?? []).map((f) => f.podSelector?.matchLabels?.['app.kubernetes.io/component'] ?? '?').sort();

describe('the tunnel services', () => {
  const rs = render();
  const daemon = container(find(rs, 'Deployment', 'hopper'), 'hopper');

  it('run the scripts of compose.yaml, unchanged but for compose\'s $$ escape', () => {
    const compose = parse(readFileSync(join(CHART, '..', '..', '..', 'compose.yaml'), 'utf8')) as { services: Record<string, { command: string[] }> };
    for (const [service, file] of [['tunnel', 'tunnel.sh'], ['cloudflared', 'cloudflared.sh']] as const) {
      const fromCompose = compose.services[service]!.command[0]!.replaceAll('$$', '$');
      expect(readFileSync(join(CHART, 'files', file), 'utf8'), `${file} differs from compose.yaml's ${service}: copy it again`).toBe(fromCompose);
      const script = find(rs, 'ConfigMap', `hopper-${service}-script`).data?.['script.sh'];
      expect(script?.trim()).toBe(fromCompose.trim());
    }
  });

  it('ask the hopper\'s Service by the release\'s name', () => {
    const rs2 = helm(['template', 'team', '/chart', '--namespace', 'hopper']);
    expect(rs2.status, rs2.stderr).toBe(0);
    expect(rs2.stdout).toContain('a="http://team-hopper:${HOPPER_PORT}/tunnel/agent"');
    expect(rs2.stdout).not.toContain('http://hopper:');
  });

  it('take the tunnel key from the runtime Secret, and the hopper reaches their APIs by their Services', () => {
    for (const name of ['hopper-tunnel', 'hopper-cloudflared']) {
      const vol = pod(find(rs, 'Deployment', name)).volumes?.find((v) => v.name === 'key');
      expect(vol?.secret).toMatchObject({ secretName: 'hopper-runtime', items: [{ key: 'tunnel_key', path: 'key' }] });
    }
    expect(env(daemon, 'HOPPER_TUNNEL_API')?.value).toBe('http://hopper-tunnel:4040');
    expect(env(daemon, 'HOPPER_CLOUDFLARED_API')?.value).toBe('http://hopper-cloudflared:2000');
    expect(env(daemon, 'HOPPER_TUNNEL_KEY_FILE')?.value).toBe('/run/hopper-secrets/tunnel_key');
    expect(policyFrom(rs, 'hopper-tunnel')).toEqual(['hopper']);
    expect(policyFrom(rs, 'hopper-cloudflared')).toEqual(['hopper']);
  });

  it('are left out when they are off', () => {
    const off = render('tunnel.ngrok.enabled=false', 'tunnel.cloudflared.enabled=false');
    expect(off.filter((r) => /tunnel|cloudflared/.test(r.metadata.name))).toEqual([]);
    expect(env(container(find(off, 'Deployment', 'hopper'), 'hopper'), 'HOPPER_TUNNEL_KEY_FILE')).toBeUndefined();
  });
});

describe('an external Postgres, with the vault pod and the local KMS on', () => {
  const rs = render(...all);
  const daemon = container(find(rs, 'Deployment', 'hopper'), 'hopper');
  const vault = container(find(rs, 'Deployment', 'hopper-vault'), 'hopper-vault');

  it('runs no Postgres, and every part reads the external database\'s Secret', () => {
    expect(rs.filter((r) => r.metadata.name.startsWith('hopper-postgres'))).toEqual([]);
    expect(Object.keys(find(rs, 'Secret', 'hopper-runtime').stringData ?? {}).sort()).toEqual(['openfga_key', 'tunnel_key', 'vault_key']);
    for (const c of [daemon, vault]) expect(env(c, 'HOPPER_DATABASE_URL_FILE')?.value).toBe('/run/hopper-database/database_url');
    for (const w of [find(rs, 'Deployment', 'hopper'), find(rs, 'Deployment', 'hopper-vault')]) {
      expect(pod(w).volumes?.find((v) => v.name === 'database')?.secret?.secretName).toBe('hopper-db');
    }
    const fga = container(find(rs, 'Deployment', 'hopper-openfga'), 'openfga');
    expect(env(fga, 'OPENFGA_DATASTORE_URI')?.valueFrom?.secretKeyRef).toEqual({ name: 'hopper-db', key: 'openfga_datastore_uri' });
    const job = rs.find((r) => r.kind === 'Job') as Resource;
    const schema = pod(job).initContainers?.find((c) => c.name === 'schema');
    expect(schema?.command?.join(' ')).toContain('CREATE SCHEMA IF NOT EXISTS openfga');
    expect(env(schema!, 'DATABASE_URL')?.valueFrom?.secretKeyRef).toEqual({ name: 'hopper-db', key: 'database_url' });
  });

  it('refuses an external Postgres with no Secret', () => {
    const out = helm(['template', 'hopper', '/chart', '--set', 'postgres.bundled=false']);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/postgres\.external\.existingSecret/);
  });
});

describe('the OpenFGA migration', () => {
  const jobs = (...set: string[]): string[] => render(...set).filter((r) => r.kind === 'Job').map((r) => r.metadata.name);

  it('is one Job named by its spec, so an upgrade with the same values runs it no second time', () => {
    expect(jobs()).toHaveLength(1);
    expect(jobs()).toEqual(jobs());
    expect(jobs('image.tag=dev', 'solr.enabled=false')).toEqual(jobs());
  });

  it('is a new Job when OpenFGA\'s version changes', () => {
    expect(jobs('openfga.image=docker.io/openfga/openfga:v9.9.9')).not.toEqual(jobs());
  });
});

describe('the master key, with every part on', () => {
  for (const [name, set, secret] of [['in the chart\'s Secret', all, 'hopper-master-key'], ['from a Secret given', [...all, 'masterKey.existingSecret=my-key'], 'my-key']] as const) {
    it(`${name}: every pod reads it from the mounted Secret, never as a value`, () => {
      const rs = render(...set);
      for (const w of workloads(rs)) {
        for (const c of [...pod(w).containers, ...(pod(w).initContainers ?? [])]) {
          for (const e of c.env ?? []) {
            expect(e.name, `${w.metadata.name}/${c.name}`).not.toMatch(/^HOPPER_MASTER_KEY(_PREVIOUS)?$/);
            if (/^HOPPER_MASTER_KEY/.test(e.name)) expect(e.value ?? '', `${w.metadata.name}/${c.name}`).toMatch(/^\/run\/hopper-master-key\//);
          }
          if (env(c, 'HOPPER_MASTER_KEY_FILE')) {
            const mount = c.volumeMounts?.find((m) => m.mountPath === '/run/hopper-master-key');
            expect(pod(w).volumes?.find((v) => v.name === mount?.name)?.secret?.secretName, `${w.metadata.name}/${c.name}`).toBe(secret);
          }
        }
        for (const v of pod(w).volumes ?? []) expect(v.hostPath, `${w.metadata.name} volume ${v.name}`).toBeUndefined();
      }
      expect(rs.filter((r) => r.kind === 'Secret' && /master-key/.test(r.metadata.name)).map((r) => r.metadata.name)).toEqual(secret === 'my-key' ? [] : ['hopper-master-key']);
    });
  }
});

describe('the volume claim templates, with every part on', () => {
  it('declare the API server\'s defaults, so a GitOps diff of the atomic list matches the live StatefulSet', () => {
    const sets = render(...all, 'telemetry.viewer.enabled=true', 'lanes.replicas=1').filter((r) => r.kind === 'StatefulSet');
    expect(sets.map((s) => s.metadata.name).sort()).toEqual(['hopper-kms', 'hopper-lanes', 'hopper-solr', 'hopper-telemetry']);
    const withPostgres = render('kms.local.enabled=true').filter((r) => r.kind === 'StatefulSet');
    for (const s of [...sets, ...withPostgres]) {
      for (const t of s.spec?.volumeClaimTemplates ?? []) {
        expect(t, `${s.metadata.name} claim ${t.metadata.name}`).toMatchObject({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', spec: { volumeMode: 'Filesystem' } });
      }
    }
    expect(withPostgres.map((s) => s.metadata.name)).toContain('hopper-postgres');
  });
});
