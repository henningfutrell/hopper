// Issue #708, part 9: the recipe on Settings → Vault, the page's pure model. The panel shows the template the needs make
// before a person asks for it: who approves it and why, whether it is there already, and what a box of it is given.
import { describe, expect, it } from 'vitest';
import { RECIPE_SECRETS, recipeApproval, recipeExists } from '../../ui/src/model/vault-recipe.ts';

const base = { template: 'asked-0123456789ab', image: 'box', tools: [], needs: ['read on cluster lab'], readOnly: true, approvedBy: 'the read policy' as const, waits: [] };

describe('the recipe on the page (issue #708)', () => {
  it('says who approves the template, and why it waits for a person', () => {
    expect(recipeApproval(base)).toBe('The read policy approves it: no person is needed. A read-only check runs before its first box.');
    expect(recipeApproval({ ...base, readOnly: false, approvedBy: 'a person', waits: ['write on cluster lab changes the asset', 'the read policy does not hold read on cluster prod'] }))
      .toBe('It waits for a person in Templates: write on cluster lab changes the asset; the read policy does not hold read on cluster prod.');
  });

  it('says when the template is there already, and when a person changed it', () => {
    expect(recipeExists(base)).toBeUndefined();
    expect(recipeExists({ ...base, exists: 'same' })).toBe('Template asked-0123456789ab is there already: asking again makes no second one.');
    expect(recipeExists({ ...base, exists: 'changed' })).toBe('A person changed template asked-0123456789ab since it was asked for: asking again is refused.');
  });

  it('says that the template holds no secret, and how a box gets each credential', () => {
    expect(RECIPE_SECRETS).toBe('No vault secret. A box of it asks a person for each credential the first time it loads that skill.');
  });
});
