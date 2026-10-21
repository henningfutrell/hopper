// Issue #2146: the observability skill tells a job how to read a cluster's metrics and logs through its bastion (part 4
// of the bastion path): the template request with an observe and the targets, the bastion, the hopper's relay, the
// queries, the evidence, and what it must not do.
//
// Feature: the observability skill
//   Scenario: the catalog lists it on the bastion, and its asks parse as the hopper reads them
//   Scenario: it says how to run PromQL and LogQL queries through the relay, and how to keep their results as evidence
//   Scenario: it says what a job must not do, and that Grafana's API is not reached yet
import { describe, expect, it } from 'vitest';
import { parseTargets } from '../../src/sandbox/bastion.ts';
import { catalogText, skillOf } from '../../src/skills/catalog.ts';
import { extrasOf } from '../../src/skills/template-ask.ts';

const text = skillOf('observability')!.text;

describe('the observability skill (issue #2146)', () => {
  it('the catalog lists it on the bastion, and its asks parse as the hopper reads them', () => {
    expect(catalogText()).toMatch(/^observability: .*bastion/m);
    expect(catalogText().length).toBeLessThan(1200);
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

  it('says what a job must not do, and that Grafana\'s API is not reached yet', () => {
    expect(text).toContain('no kubectl exec, no Secret reads, no change in Grafana');
    expect(text).toContain('Never print a token.');
    expect(text).toContain('do not look for another credential');
    expect(text).toContain('Grafana\'s own API needs a token, which a job does not get');
  });
});
