// Issue #2146: the observability skill tells a job how to read a cluster's metrics and logs through its bastion (part 4
// of the bastion path): the template request with an observe and the targets, the bastion, the hopper's relay, the
// queries, the evidence, and what it must not do. Part 6: Grafana's API through a bastion read, its token kept in the box.
//
// Feature: the observability skill
//   Scenario: the catalog lists it on the bastion, and its asks parse as the hopper reads them
//   Scenario: it says how to run PromQL and LogQL queries through the relay, and how to keep their results as evidence
//   Scenario: it says what a job must not do
//   Scenario: it says how to read Grafana's API with a bastion read, and its asks parse as the hopper reads them
import { describe, expect, it } from 'vitest';
import { parseTargets } from '../../src/sandbox/bastion.ts';
import { parseRead } from '../../src/sandbox/bastion-read.ts';
import { catalogText, skillOf } from '../../src/skills/catalog.ts';
import { extrasOf } from '../../src/skills/template-ask.ts';

const text = skillOf('observability')!.text;

describe('the observability skill (issue #2146)', () => {
  it('the catalog lists it on the bastion, and its asks parse as the hopper reads them', () => {
    expect(catalogText()).toMatch(/^observability: .*bastion/m);
    expect(catalogText().length).toBeLessThan(1300);
    expect(skillOf('observability')!.link).toBeUndefined();
    expect(text).toContain('sh "$HOPPER_SKILL" sandbox-template --why "<why>" --needs "observe/namespace/CLUSTER/monitoring" --targets "');
    expect(text).toContain('sh "$HOPPER_SKILL" bastion --template TEMPLATE --targets "<the same targets>" --why "<why>"');
    const targets = /--targets "(CLUSTER[^"]+)"/.exec(text)![1]!;
    expect(extrasOf({ targets })).toMatchObject({ targets: targets.split(' ').sort() });
    expect(Array.isArray(parseTargets(targets))).toBe(true);
    expect(text).toContain('sh "$HOPPER_SKILL" bastion stop');
    expect(text).toContain('sh "$HOPPER_STEP" need "read/namespace/CLUSTER/monitoring"');
  });

  it('says how to run PromQL and LogQL queries through the relay, and how to keep their results as evidence', () => {
    expect(text).toContain('sh "$HOPPER_RELAY" TARGET -- COMMAND');
    expect(text).toContain('http://127.0.0.1:$HOPPER_RELAY_PORT/api/v1/query ');
    expect(text).toContain('/api/v1/query_range');
    expect(text).toContain('/loki/api/v1/query_range');
    expect(text).toContain('promtool query range');
    expect(text).toContain('logcli --addr=');
    expect(text).toContain('@tsv');
    expect(text).not.toContain('hopper-port-forward');
  });

  it('says what a job must not do', () => {
    expect(text).toContain('no kubectl exec, no Secret reads, no change in Grafana');
    expect(text).toContain('Never print a token.');
    expect(text).toContain('do not look for another credential');
  });

  it('says how to read Grafana\'s API with a bastion read, and its asks parse as the hopper reads them (part 6)', () => {
    expect(text).toContain('which stays in the bastion\'s box: you never get it');
    const read = /bastion read --targets (\S+) --secrets (\S+) --path "([^"]+)"/.exec(text)!;
    expect(parseRead({ target: read[1], secret: read[2], path: read[3] })).toMatchObject({ method: 'GET', path: '/api/search?query=<words>' });
    const post = /--path (\/api\/ds\/query) --data '([^']+)'/.exec(text)!;
    expect(parseRead({ target: read[1], path: post[1], data: post[2] })).toMatchObject({ method: 'POST' });
    expect(parseRead({ target: read[1], path: /A dashboard: --path (\S+)\./.exec(text)![1] })).toMatchObject({ method: 'GET' });
  });
});
