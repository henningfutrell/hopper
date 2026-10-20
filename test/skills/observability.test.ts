// Issue #2146: the observability skill tells a job how to read a cluster's metrics, logs and dashboards in a sandbox:
// the tools it asks for, the port-forward helper, the Grafana Viewer token as a vault secret, and what it must not do.
//
// Feature: the observability skill
//   Scenario: the catalog lists it, and it names only tools the hopper adds
//   Scenario: it says how to run PromQL, LogQL and Grafana queries, and how to keep their results as evidence
//   Scenario: it says what a job must not do
import { describe, expect, it } from 'vitest';
import { BOX_TOOLS } from '../../src/domain/sandboxes.ts';
import { catalogText, skillOf } from '../../src/skills/catalog.ts';
import { extrasOf } from '../../src/skills/template-ask.ts';

const text = skillOf('observability')!.text;

describe('the observability skill (issue #2146)', () => {
  it('the catalog lists it, and it names only tools the hopper adds', () => {
    expect(catalogText()).toMatch(/^observability: /m);
    const tools = /--tools "([^"]+)"/.exec(text)![1]!;
    expect(extrasOf({ tools })).toEqual({ secrets: [], egress: [], tools: ['jq', 'logcli', 'promtool'] });
    for (const t of tools.split(' ')) expect(BOX_TOOLS).toContain(t);
    expect(skillOf('observability')!.link).toBeUndefined();
  });

  it('says how to run PromQL, LogQL and Grafana queries, and how to keep their results as evidence', () => {
    expect(text).toContain('hopper-port-forward [-n NAMESPACE] svc/NAME LOCAL[:REMOTE] -- COMMAND');
    expect(text).toContain('/api/v1/query ');
    expect(text).toContain('/api/v1/query_range');
    expect(text).toContain('promtool query range');
    expect(text).toContain('logcli --addr=http://127.0.0.1:3100 query');
    expect(text).toContain('$("$HOPPER_SECRET" get GRAFANA_TOKEN)');
    expect(text).toContain('/api/dashboards/uid/UID');
    expect(text).toContain('@tsv');
    expect(text).toContain('sh "$HOPPER_STEP" box TEMPLATE');
  });

  it('says what a job must not do', () => {
    expect(text).toContain('no kubectl exec, no Secret reads, no change in Grafana');
    expect(text).toContain('Never print the token.');
    expect(text).toContain('do not look for another credential');
  });
});
