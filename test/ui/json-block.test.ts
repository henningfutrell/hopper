// @vitest-environment happy-dom
// Issue #1169: data shown as JSON is one small code block — a job step's data, a decider decision's raw inputs, the
// built-in change rule — with a copy button that copies the JSON, and a screen-reader label.
//
// Feature: the JSON block
//   Scenario: a value shows as indented JSON in a small code block, with copy
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

const { JsonBlock } = (await import('../../ui/src/components/json-block.tsx')) as {
  JsonBlock: (p: { value: unknown; label: string; className?: string }) => ReturnType<typeof createElement>;
};

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

describe('the JSON block', () => {
  it('shows a value as indented JSON in a small code block, labelled, with copy', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(document.getElementById('root')!);
    act(() => root!.render(createElement(JsonBlock, { value: { a: 1, b: ['x'] }, label: 'raw inputs' })));
    const block = document.querySelector<HTMLElement>('[data-slot="code-block"]')!;
    expect(block.dataset.size).toBe('sm');
    expect(block.querySelector('[data-slot="code-block-content"]')!.getAttribute('aria-label')).toBe('raw inputs');
    expect(block.textContent).toContain('"a": 1');
    expect(block.querySelector('[data-slot="code-block-copy-button"]')).not.toBeNull();
  });
});
