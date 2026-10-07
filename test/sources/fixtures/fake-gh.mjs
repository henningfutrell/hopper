#!/usr/bin/env node
/* global process, setTimeout */
// A stand-in `gh` binary for the gh CLI adapter tests. Appends {argv, stdin, mark} to calls.jsonl
// in FAKE_GH_DIR and answers from a canned table. Never talks to GitHub.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const stdin = argv.includes('--input') ? readFileSync(0, 'utf8') : null;
appendFileSync(join(process.env.FAKE_GH_DIR, 'calls.jsonl'), JSON.stringify({ argv, stdin, mark: process.env.FAKE_GH_MARK ?? null }) + '\n');

const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const fail = (text) => { process.stderr.write(text); process.exit(1); };
const cmd = argv.join(' ');

const searchHit = (n, repo, extra = {}) => ({
  url: `https://github.com/${repo}/issues/${n}`, number: n, title: `Issue ${n}`, body: `body ${n}`, state: 'open',
  author: { login: 'owner', type: 'User' }, labels: [{ name: 'hopper', color: 'ededed' }],
  repository: { name: repo.split('/')[1], nameWithOwner: repo }, updatedAt: '2026-10-02T09:00:00Z', ...extra,
});
const restComment = (id, login, body) => ({
  id, body, user: { login }, created_at: `2026-10-02T09:00:0${id % 10}Z`, html_url: `https://github.com/o/r/issues/5#issuecomment-${id}`,
});

if (cmd === 'api user --jq .login') out('owner\n');
else if (cmd.startsWith('search issues')) out([searchHit(1, 'o/r'), searchHit(2, 'p/q', { body: '', labels: [] })]);
else if (cmd.startsWith('issue list')) {
  const { number, title, body, state, author, labels, updatedAt, url } = searchHit(3, argv[argv.indexOf('-R') + 1]);
  out([{ number, title, body, state, author, labels, updatedAt, url }]);
}
else if (cmd === 'api repos/o/r/issues/5') out({
  number: 5, title: 'T', body: null, state: 'closed', html_url: 'https://github.com/o/r/issues/5', updated_at: '2026-10-02T09:30:00Z',
  user: { login: 'owner' }, labels: [{ name: 'hopper' }, { name: 'hopper:claimed' }], closed_by: { login: 'someone' },
  closed_at: '2026-10-02T09:30:00Z', state_reason: 'completed',
});
else if (cmd === 'api repos/o/r/issues/404') fail('gh: Not Found (HTTP 404)\n');
else if (cmd === 'api repos/o/r/issues/410') fail('gh: This issue was deleted (HTTP 410)\n');
else if (cmd === 'api repos/o/r/issues/502') fail('gh: Bad Gateway (HTTP 502)\n');
else if (cmd === 'api repos/o/r/issues/429') fail('gh: API rate limit exceeded for user ID 1. (HTTP 403)\n');
else if (cmd === 'api repos/o/r/issues/7') out('this is not json');
else if (cmd === 'api repos/o/r/issues/999') setTimeout(() => out({}), 5000);
else if (cmd === 'api --paginate --slurp repos/o/r/issues/5/comments?per_page=100') out([
  [restComment(11, 'owner', 'first'), restComment(12, 'other', 'second')],
  [restComment(13, 'owner', 'third')],
]);
else if (cmd === 'api repos/o/r/issues/5/comments -X POST --input -') {
  const { body } = JSON.parse(stdin);
  out({ ...restComment(901, 'owner', body) });
}
else if (cmd === 'api repos/o/r/issues/comments/77 -X PATCH --input -') {
  const { body } = JSON.parse(stdin);
  out({ ...restComment(77, 'owner', body) });
}
else if (argv[0] === 'api' && argv[1] === 'graphql' && argv.some((a) => a.includes('closedByPullRequestsReferences'))) {
  const number = argv.find((a) => a.startsWith('number='))?.slice('number='.length);
  const nodes = number !== '5' ? [] : [
    { url: 'https://github.com/o/r/pull/10', createdAt: '2026-10-02T09:30:00Z', isDraft: false, state: 'OPEN' },
    { url: 'https://github.com/o/r/pull/11', createdAt: '2026-10-02T09:40:00Z', isDraft: true, state: 'OPEN' },
    { url: 'https://github.com/o/r/pull/12', createdAt: '2026-10-02T09:50:00Z', isDraft: false, state: 'CLOSED' },
  ];
  out({ data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } } });
}
else if (argv[0] === 'api' && argv[1] === 'graphql') {
  const number = argv.find((a) => a.startsWith('number='))?.slice('number='.length);
  const closer = number === '5' ? { __typename: 'PullRequest', url: 'https://github.com/o/r/pull/9', createdAt: '2026-10-02T09:10:00Z', mergedAt: '2026-10-02T09:20:00Z' }
    : number === '8' ? { __typename: 'Commit' } : null;
  out({ data: { repository: { issue: { timelineItems: { nodes: [{ closer }] } } } } });
}
else if (cmd.startsWith('label create') || cmd.startsWith('issue edit')) out('');
else if (cmd.startsWith('project item-list 3 ')) out({
  items: [
    { id: 'PVTI_1', title: 'Issue 5', priority: 'P1', status: 'Todo', 'story points': 3, content: { type: 'Issue', number: 5, url: 'https://github.com/o/r/issues/5', repository: 'o/r' } },
    { id: 'PVTI_2', title: 'a draft', content: { type: 'DraftIssue', title: 'a draft' } },
    { id: 'PVTI_3', title: 'Issue 6', content: { type: 'Issue', number: 6, url: 'https://github.com/o/r/issues/6', repository: 'o/r' } },
  ],
  totalCount: 3,
});
else if (cmd.startsWith('project item-list 9 ')) fail('error: your authentication token is missing required scopes [read:project]\nTo request it, run:  gh auth refresh -s read:project\n');
else fail(`fake gh: unhandled: ${cmd}\n`);
