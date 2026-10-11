// Issue #716, item 2: a box's tools are assembled per run. The hopper writes a Containerfile that adds the named tools
// to the box image: each from its own release, pinned, and checked by its SHA-256 before it is kept. Pure:
// src/sandbox/tools.ts. The build through a runtime: test/adapters/podman-runtime.test.ts, docker-runtime.test.ts; a
// launch with tools: test/integration/sandbox-lifecycle.test.ts.
//
// Feature: the tools image
//   Scenario: the Containerfile starts from the box image and adds only the tools named, each checked by its SHA-256
//   Scenario: the same tools in any order give the same image; other tools or another base give another
//   Scenario: a tool the hopper does not add is refused, naming the ones it adds
//   Scenario: the tools a need's asset kind uses
//   Scenario: a read-only template's image puts the read-only terraform wrapper first on PATH (issue #715)
//   Scenario: a read-only template's image holds the AWS provider in a mirror terraform installs only from (issue #715)
import { describe, expect, it } from 'vitest';
import { BOX_TOOLS, toolsProblem } from '../../src/domain/sandboxes.ts';
import { TERRAFORM_CLI_CONFIG, TERRAFORM_WRAPPER } from '../../src/sandbox/terraform-wrapper.ts';
import { TOOLS_IMAGE, toolsForNeeds, toolsImage } from '../../src/sandbox/tools.ts';

const BASE = { image: 'ghcr.io/henningfutrell/hopper:box-claude', id: 'sha256:base1' };
const SHA = /^[0-9a-f]{64}$/;

describe('the tools image (issue #716)', () => {
  it('the Containerfile starts from the box image and adds only the tools named, each checked by its SHA-256', () => {
    const { containerfile } = toolsImage(BASE, ['kubectl', 'aws']);
    expect(containerfile).toContain(`FROM ${BASE.image}\n`);
    expect(containerfile).toMatch(/FROM docker\.io\/library\/debian:bookworm-slim@sha256:[0-9a-f]{64} AS fetch/);
    expect(containerfile).toContain('COPY --from=fetch /opt/hopper-tools/ /opt/hopper-tools/');
    expect(containerfile).toContain('ENV PATH=/opt/hopper-tools/bin:${PATH}');
    expect(containerfile).toContain('https://dl.k8s.io/release/v');
    expect(containerfile).toContain('https://awscli.amazonaws.com/awscli-exe-linux-');
    expect(containerfile).not.toContain('get.helm.sh');
    expect(containerfile).not.toContain('releases.hashicorp.com');
    // Every download is checked: one `sha256sum -c` per tool, and a sum per architecture.
    expect(containerfile.match(/sha256sum -c/g)).toHaveLength(2);
    for (const m of containerfile.matchAll(/(amd64|arm64)\) sum=([0-9a-f]+)/g)) expect(m[2]).toMatch(SHA);
    expect(containerfile).toContain('io.hopper.tools="aws kubectl"');
  });

  it('every tool the hopper adds has a recipe', () => {
    const { containerfile } = toolsImage(BASE, [...BOX_TOOLS]);
    expect(containerfile.match(/sha256sum -c/g)).toHaveLength(BOX_TOOLS.length);
  });

  it('the same tools in any order give the same image; other tools or another base give another', () => {
    const a = toolsImage(BASE, ['kubectl', 'aws']);
    expect(a.tag).toMatch(new RegExp(`^${TOOLS_IMAGE}:[0-9a-f]{16}$`));
    expect(toolsImage(BASE, ['aws', 'kubectl', 'aws']).tag).toBe(a.tag);
    expect(toolsImage(BASE, ['kubectl']).tag).not.toBe(a.tag);
    expect(toolsImage({ ...BASE, id: 'sha256:base2' }, ['kubectl', 'aws']).tag).not.toBe(a.tag);
  });

  it('a tool the hopper does not add is refused, naming the ones it adds', () => {
    expect(toolsProblem(['kubectl', 'helm'])).toBeUndefined();
    expect(toolsProblem(['kubectl', 'nmap'])).toBe('nmap is not a tool the hopper adds to a box: it adds aws, helm, kubectl, terraform');
  });

  it('the tools a need\'s asset kind uses', () => {
    const need = (kind: string) => ({ operation: 'read' as const, asset: { kind: kind as 'cluster', name: 'x' } });
    expect(toolsForNeeds([need('cluster')])).toEqual(['helm', 'kubectl']);
    expect(toolsForNeeds([need('aws-account'), need('namespace')])).toEqual(['aws', 'helm', 'kubectl']);
    expect(toolsForNeeds([need('terraform-workspace')])).toEqual(['aws', 'terraform']);
    expect(toolsForNeeds([need('argocd-app')])).toEqual(['kubectl']);
  });

  it('a read-only template\'s image puts the read-only terraform wrapper first on PATH (issue #715)', () => {
    const ro = toolsImage(BASE, ['terraform', 'aws'], { readOnly: true });
    const b64 = Buffer.from(TERRAFORM_WRAPPER).toString('base64');
    expect(ro.containerfile).toContain(`echo ${b64} | base64 -d > /opt/hopper-tools/read-only/terraform && chmod 755 /opt/hopper-tools/read-only/terraform`);
    expect(ro.containerfile).toContain('ENV PATH=/opt/hopper-tools/read-only:/opt/hopper-tools/bin:${PATH}');
    // The real binary stays where the check's probes call it past the wrapper.
    expect(ro.containerfile).toContain('/opt/hopper-tools/bin/terraform');
    // Another image: a template that is not read-only, or one with no terraform, gets no wrapper.
    const plain = toolsImage(BASE, ['terraform', 'aws']);
    expect(plain.containerfile).not.toContain('read-only');
    expect(plain.tag).not.toBe(ro.tag);
    expect(toolsImage(BASE, ['aws'], { readOnly: true }).containerfile).not.toContain('read-only');
    expect(toolsImage(BASE, ['aws'], { readOnly: true }).tag).toBe(toolsImage(BASE, ['aws']).tag);
  });

  it('a read-only template\'s image holds the AWS provider in a mirror terraform installs only from (issue #715)', () => {
    const ro = toolsImage(BASE, ['terraform', 'aws'], { readOnly: true });
    // The provider's own release, pinned and checked by its SHA-256 like each tool, kept in the mirror's packed layout.
    expect(ro.containerfile).toMatch(/https:\/\/releases\.hashicorp\.com\/terraform-provider-aws\/(\d+\.\d+\.\d+)\/terraform-provider-aws_\1_linux_\$\{a\}\.zip/);
    expect(ro.containerfile).toMatch(/\/opt\/hopper-tools\/providers\/registry\.terraform\.io\/hashicorp\/aws\/terraform-provider-aws_\d+\.\d+\.\d+_linux_\$a\.zip/);
    expect(ro.containerfile.match(/sha256sum -c/g)).toHaveLength(3);
    for (const m of ro.containerfile.matchAll(/(amd64|arm64)\) sum=([0-9a-f]+)/g)) expect(m[2]).toMatch(SHA);
    // The CLI config names the mirror and no other way to install: no registry, no network mirror.
    expect(TERRAFORM_CLI_CONFIG).toContain('filesystem_mirror');
    expect(TERRAFORM_CLI_CONFIG).toContain('path = "/opt/hopper-tools/providers"');
    expect(TERRAFORM_CLI_CONFIG).not.toMatch(/direct|network_mirror|plugin_cache_dir/);
    const rc = Buffer.from(TERRAFORM_CLI_CONFIG).toString('base64');
    expect(ro.containerfile).toContain(`echo ${rc} | base64 -d > /opt/hopper-tools/terraform.rc`);
    // The real binary reads it too, called past the wrapper.
    expect(ro.containerfile).toContain('ENV TF_CLI_CONFIG_FILE=/opt/hopper-tools/terraform.rc');
    // A plain terraform image installs as terraform does by default.
    const plain = toolsImage(BASE, ['terraform', 'aws']).containerfile;
    expect(plain).not.toContain('terraform-provider-aws');
    expect(plain).not.toContain('TF_CLI_CONFIG_FILE');
  });
});
