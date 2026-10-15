import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { parseStackedPullRequestRange } = require('../git-state/stacked-pull-request.cjs') as {
  parseStackedPullRequestRange: (
    body: string | null | undefined,
    pullRequest: { number: number; owner: string; repo: string },
  ) => { base: string; head: string } | undefined;
};
const pullRequest = { number: 2783867, owner: 'databricks-eng', repo: 'universe' };
const base = 'f30eb41593ce7f5a3e1d17b997ec35dcc987b75f';
const head = '94dfb29ebb8fede824ba033fc01d3542c7d6c863';
const currentUrl = `https://github.com/databricks-eng/universe/pull/2783867/files/${base}..${head}`;

test('selects this PR’s incremental range instead of its stacked neighbors', () => {
  expect(
    parseStackedPullRequestRange(
      `## 🥞 Stacked PR
Use this [link](${currentUrl}) to review incremental changes.
- [stack/parent](https://github.com/databricks-eng/universe/pull/2730635) [[Files changed](https://github.com/databricks-eng/universe/pull/2730635/files/${'a'.repeat(40)}..${base})]
  - [**stack/buffa-codegen-file-resolution**](https://github.com/databricks-eng/universe/pull/2783867) [[Files changed](${currentUrl})] ← _this PR_
    - [stack/child](https://github.com/databricks-eng/universe/pull/2766478) [[Files changed](https://github.com/databricks-eng/universe/pull/2766478/files/${head}..${'c'.repeat(40)})]`,
      pullRequest,
    ),
  ).toEqual({ base, head });
});

test('accepts query strings, anchors and case-insensitive repository names', () => {
  expect(
    parseStackedPullRequestRange(
      `[Files changed](${currentUrl.replace('databricks-eng/universe', 'DATABRICKS-ENG/Universe')}?diff=split#diff-123)`,
      pullRequest,
    ),
  ).toEqual({ base, head });
});

test.each([
  undefined,
  null,
  '',
  'An ordinary PR description',
  currentUrl.replace('github.com', 'example.com'),
  currentUrl.replace('/universe/', '/other/'),
  currentUrl.replace('/2783867/', '/2783868/'),
  currentUrl.replace('/databricks-eng/', '/someone-else/'),
  currentUrl.replace('/files/', '/commits/'),
  currentUrl.replace('..', '...'),
  currentUrl.replace(base, 'main'),
])('does not select an unrelated or malformed comparison: %s', (body) => {
  expect(parseStackedPullRequestRange(body, pullRequest)).toBeUndefined();
});

test('rejects conflicting ranges for the current PR instead of guessing', () => {
  expect(() =>
    parseStackedPullRequestRange(
      `[Files changed](${currentUrl})\n[Files changed](${currentUrl.replace(base, 'a'.repeat(40))})`,
      pullRequest,
    ),
  ).toThrow(/conflicting.*range/i);
});
