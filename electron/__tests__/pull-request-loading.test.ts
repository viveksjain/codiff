import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironmentForSubprocess } from '../../core/__tests__/helpers/git.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import {
  createSectionContentRequest,
  getSectionForFileDiff,
  getVisibleDiffSections,
  loadSectionContents,
  shouldLoadDiffSectionContents,
} from '../../core/lib/diff.ts';
import {
  supportsDiffSearchContentPreload,
  supportsLazyDiffContent,
} from '../../core/lib/source.ts';
import type {
  DiffSection,
  DiffSectionContentRequest,
  DiffImageContentRequest,
  DiffImageContentResult,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
  SubmitPullRequestCommentRequest,
  SubmitPullRequestReviewRequest,
} from '../../core/types.ts';
import type { RepositoryHost } from '../host/repository-host.cjs';

const require = createRequire(import.meta.url);
const { createLocalHost } = require('../host/local-host.cjs') as {
  createLocalHost: () => RepositoryHost;
};
const {
  readDiffImageContent,
  readDiffSectionContent,
  listRepositoryHistory: readRepositoryHistory,
  readRepositoryState,
  readWalkthroughRepositoryState,
  submitPullRequestComment,
  submitPullRequestReview,
} = require('../git-state.cjs') as {
  readDiffImageContent: (
    host: RepositoryHost,
    root: string,
    request: DiffImageContentRequest,
  ) => Promise<DiffImageContentResult>;
  listRepositoryHistory: (
    host: RepositoryHost,
    root: string,
    limit: number,
    source: ReviewSource,
  ) => Promise<RepositoryHistory>;
  readWalkthroughRepositoryState: (
    host: RepositoryHost,
    root: string,
    source: ReviewSource,
  ) => Promise<RepositoryState>;
  submitPullRequestComment: (
    host: RepositoryHost,
    root: string,
    request: SubmitPullRequestCommentRequest,
  ) => Promise<unknown>;
  submitPullRequestReview: (
    host: RepositoryHost,
    root: string,
    request: SubmitPullRequestReviewRequest,
  ) => Promise<void>;
  readRepositoryState: (
    host: RepositoryHost,
    root: string,
    source: ReviewSource,
  ) => Promise<RepositoryState>;
  readDiffSectionContent: (
    host: RepositoryHost,
    root: string,
    request: DiffSectionContentRequest,
  ) => Promise<DiffSection>;
};
const { listPullRequestHistory, readPullRequestState } =
  require('../git-state/pull-request.cjs') as {
    listPullRequestHistory: (
      host: RepositoryHost,
      root: string,
      source: Extract<ReviewSource, { type: 'pull-request' }>,
      limit?: number,
    ) => Promise<RepositoryHistory>;
    readPullRequestState: (
      host: RepositoryHost,
      root: string,
      source: Extract<ReviewSource, { type: 'pull-request' }>,
    ) => Promise<RepositoryState>;
  };
const execFileAsync = promisify(execFile);
const base = 'b'.repeat(40);
const head = 'c'.repeat(40);
const mergeBase = 'a'.repeat(40);
const oldEndpoint = `repos/acme/widgets/contents/file.txt?ref=${mergeBase}`;
const newEndpoint = `repos/contributor/widgets/contents/file.txt?ref=${head}`;
const patch =
  'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -2 +2 @@\n-before\n+after\n';
const createResponses = () => ({
  failures: {} as Record<string, string>,
  submittedComment: {
    body: 'Review comment',
    diff_hunk: '@@ -2 +2 @@',
    id: 123,
    line: 2,
    path: 'file.txt',
    side: 'RIGHT',
  },
  commit: {
    sha: head,
    parents: [{ sha: mergeBase }],
    commit: { author: { name: 'Reviewer', date: '2026-10-13T12:00:00Z' }, message: 'PR' },
    files: [{ filename: 'file.txt', status: 'modified', patch: '@@ -2 +2 @@\n-before\n+after' }],
  },
  baseCommits: [
    { commit: { author: { date: '2026-10-13T12:00:00Z' }, message: 'Base' }, sha: base },
  ],
  comments: [[]] as Record<string, unknown>[][],
  commits: [[{ commit: { author: { date: '2026-10-13T12:00:00Z' }, message: 'PR' }, sha: head }]],
  comparison: {
    base_commit: { sha: mergeBase },
    merge_base_commit: { sha: mergeBase },
    commits: [{ commit: { author: { date: '2026-10-13T12:00:00Z' }, message: 'PR' }, sha: head }],
    files: [{ filename: 'file.txt', patch: '@@ -2 +2 @@\n-before\n+after', status: 'modified' }],
  },
  comparisonDiff: patch,
  contents: {
    [`repos/contributor/widgets/contents/file.txt?ref=${mergeBase}`]: 'unchanged\nbefore\nmore\n',
    [newEndpoint]: 'unchanged\nafter\nmore\n',
    [oldEndpoint]: 'unchanged\nbefore\nmore\n',
  } as Record<string, string | null>,
  diff: patch,
  files: [
    [{ filename: 'file.txt', patch: '@@ -2 +2 @@\n-before\n+after', status: 'modified' }],
  ] as { filename: string; patch?: string; previous_filename?: string; status: string }[][],
  metadata: {
    base: { ref: 'main', sha: base },
    body: '',
    head: { repo: { full_name: 'contributor/widgets' }, sha: head },
    title: 'Review',
  },
  threads: {
    data: {
      repository: {
        pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
      },
    },
  },
});

const withPullRequest = async (
  callback: (fixture: {
    gitRequests: string[][];
    host: RepositoryHost;
    requests: () => Promise<string[]>;
    responses: ReturnType<typeof createResponses>;
    root: string;
    saveResponses: () => Promise<void>;
    source: Extract<ReviewSource, { type: 'pull-request' }>;
  }) => Promise<void>,
) => {
  await using directory = await createTemporaryDirectory('codiff-pr-loading-');
  const root = directory.path;
  const git = (...args: string[]) =>
    execFileAsync('git', ['-C', root, ...args], { env: getGitTestEnvironmentForSubprocess() });
  await git('init', '-b', 'main');
  await git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  // None of the PR's commits or files exist locally.
  const responses = createResponses();
  const saveResponses = () => writeFile(join(root, 'responses.json'), JSON.stringify(responses));
  await saveResponses();
  await writeFile(join(root, 'requests.jsonl'), '');
  const gh = join(root, 'gh.cjs');
  await writeFile(
    gh,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const responses = require('./responses.json');
const args = process.argv.slice(2);
const endpoint = args.find(arg => arg.startsWith('repos/')) || 'graphql';
appendFileSync(__dirname + '/requests.jsonl', JSON.stringify(endpoint) + '\\n');
const operation = args.includes('Accept: application/vnd.github.v3.diff')
  ? endpoint.includes('/compare/') ? 'comparisonDiff' : 'diff'
  : endpoint;
if (responses.failures[operation]) {
  process.stderr.write(responses.failures[operation]);
  process.exit(1);
}
let response;
if (args.includes('graphql')) response = responses.threads;
else if (args.includes('Accept: application/vnd.github.v3.diff')) response = responses[operation];
else if (endpoint.includes('/contents/')) {
  response = responses.contents[endpoint];
  if (response == null) { process.stderr.write('HTTP 404: Not Found'); process.exit(1); }
}
else if (endpoint.includes('/compare/')) response = args.includes('--slurp') ? [responses.comparison] : responses.comparison;
else if (endpoint.includes('/files?')) response = responses.files;
else if (endpoint.includes('/comments?')) response = responses.comments;
else if (endpoint.endsWith('/comments')) response = responses.submittedComment;
else if (endpoint.endsWith('/reviews')) response = {};
else if (endpoint.includes('/pulls/42/commits?')) response = responses.commits;
else if (endpoint.includes('/commits/')) response = [responses.commit];
else if (endpoint.includes('/commits?')) response = endpoint.endsWith('page=1') ? responses.baseCommits : [];
else if (endpoint === 'repos/acme/widgets/pulls/42') response = responses.metadata;
else throw new Error('Unexpected GitHub request: ' + args.join(' '));
process.stdout.write(typeof response === 'string' ? response : JSON.stringify(response));
`,
  );
  await chmod(gh, 0o755);
  await using _environment = createTemporaryEnvironment({ CODIFF_GH_PATH: gh, SHELL: undefined });
  const local = createLocalHost();
  const gitRequests: string[][] = [];
  const unsafeRequests: string[][] = [];
  const host: RepositoryHost = {
    ...local,
    exec: (command, args, options) => {
      if (command === 'git') {
        gitRequests.push([...args]);
        if (!['rev-parse', 'remote', 'config', 'symbolic-ref'].includes(args[2])) {
          unsafeRequests.push([...args]);
          return Promise.reject(new Error('PR Git data unavailable.'));
        }
        expect(options?.env?.GIT_NO_LAZY_FETCH).toBe('1');
      }
      return local.exec(command, args, options);
    },
  };
  await callback({
    gitRequests,
    host,
    requests: async () =>
      (await readFile(join(root, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    responses,
    root,
    saveResponses,
    source: { type: 'pull-request', url: 'https://github.com/acme/widgets/pull/42' },
  });
  expect(unsafeRequests).toEqual([]);
};

test('opens a PR through the full repository loader without local Git objects or eager file contents', async () => {
  await withPullRequest(async ({ gitRequests, host, requests, root, source }) => {
    const state = await readRepositoryState(host, root, source);
    expect(state.source).toMatchObject({ baseSha: base, headSha: head, title: 'Review' });
    const section = state.files[0].sections[0];
    expect(section.patch).toBe(patch);
    expect(section.oldFile).toBeUndefined();
    expect(section.newFile).toBeUndefined();
    expect(section.summary?.canLoad).toBe(true);
    expect(gitRequests.map((args) => args[2])).toEqual([
      'rev-parse',
      'remote',
      'config',
      'symbolic-ref',
    ]);
    expect((await requests()).some((endpoint) => /\/contents\/|\/compare\//.test(endpoint))).toBe(
      false,
    );
  });
});

test('opens only the stack entry’s files and preserves its exact range for refresh and walkthroughs', async () => {
  await withPullRequest(async ({ host, requests, responses, root, saveResponses, source }) => {
    responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${mergeBase}..${head})`;
    responses.files[0].push({ filename: 'parent-only.txt', status: 'added' });
    responses.diff = patch.replace('-before\n+after', '-stack-base\n+after');
    await saveResponses();
    const state = await readRepositoryState(host, root, source);
    expect(state.files.map((file) => file.path)).toEqual(['file.txt']);
    expect(state.files[0].sections[0].patch).toBe(patch);
    expect(state.source).toMatchObject({
      baseSha: mergeBase,
      headSha: head,
      commitRange: { base: mergeBase, head },
    });
    expect((await readRepositoryState(host, root, state.source)).files).toEqual(state.files);
    expect((await readWalkthroughRepositoryState(host, root, source)).files).toEqual(state.files);
    expect((await requests()).some((endpoint) => endpoint.includes('/pulls/42/files'))).toBe(false);
    expect((await requests()).some((endpoint) => endpoint.includes('/contents/'))).toBe(false);
  });
});

test('fails clearly when the selected stack range cannot be loaded instead of showing the whole stack', async () => {
  await withPullRequest(async ({ host, responses, root, saveResponses, source }) => {
    responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${mergeBase}..${head})`;
    responses.failures[`repos/acme/widgets/compare/${mergeBase}...${head}?per_page=100`] =
      'HTTP 404: Not Found';
    await saveResponses();
    await expect(readRepositoryState(host, root, source)).rejects.toThrow(/stack.*range.*404/is);
  });
});

test('expands a stacked snapshot at the linked commits after the PR and description change', async () => {
  await withPullRequest(async ({ host, requests, responses, root, saveResponses, source }) => {
    const stackBase = 'd'.repeat(40);
    const stackHead = 'e'.repeat(40);
    responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${stackBase}..${stackHead})`;
    responses.comparison.merge_base_commit.sha = stackBase;
    responses.contents[`repos/acme/widgets/contents/file.txt?ref=${stackBase}`] = 'stack-before\n';
    responses.contents[`repos/contributor/widgets/contents/file.txt?ref=${stackHead}`] =
      'stack-after\n';
    await saveResponses();
    const state = await readPullRequestState(host, root, source);
    responses.metadata.body = '';
    responses.metadata.head.sha = 'f'.repeat(40);
    responses.comparison.merge_base_commit.sha = mergeBase;
    responses.files = [[{ filename: 'parent-only.txt', status: 'added' }]];
    responses.failures['repos/acme/widgets/pulls/42'] = 'HTTP 503: Service Unavailable';
    await saveResponses();
    const section = await readDiffSectionContent(
      host,
      root,
      createSectionContentRequest(state.files[0], state.files[0].sections[0], state.source, false),
    );
    expect(section.oldFile?.contents).toBe('stack-before\n');
    expect(section.newFile?.contents).toBe('stack-after\n');
    expect(section.patch).toBe(patch);
    expect((await requests()).filter((endpoint) => endpoint.includes('/contents/')).sort()).toEqual(
      [
        `repos/acme/widgets/contents/file.txt?ref=${stackBase}`,
        `repos/contributor/widgets/contents/file.txt?ref=${stackHead}`,
      ],
    );
  });
});

test('loads stacked context and images from the range when no displayed snapshot is supplied', async () => {
  await withPullRequest(async ({ host, requests, responses, root, saveResponses, source }) => {
    const stackBase = 'd'.repeat(40);
    responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${stackBase}..${head})`;
    responses.comparison.merge_base_commit.sha = stackBase;
    responses.comparison.files.push({ filename: 'image.png', patch: '', status: 'modified' });
    responses.files = [[{ filename: 'parent-only.txt', status: 'added' }]];
    responses.contents[`repos/acme/widgets/contents/file.txt?ref=${stackBase}`] = 'stack-before\n';
    responses.contents[`repos/acme/widgets/contents/image.png?ref=${stackBase}`] =
      'stack-old-image';
    responses.contents[`repos/contributor/widgets/contents/image.png?ref=${head}`] =
      'stack-new-image';
    await saveResponses();
    const section = await readDiffSectionContent(host, root, {
      kind: 'pull-request',
      path: 'file.txt',
      source,
    });
    expect(section.oldFile?.contents).toBe('stack-before\n');
    expect(section.newFile?.contents).toBe('unchanged\nafter\nmore\n');
    const image = await readDiffImageContent(host, root, {
      kind: 'pull-request',
      path: 'image.png',
      source,
    });
    expect(image).toMatchObject({ status: 'ready' });
    if (image.status === 'ready') {
      expect(image.oldImage?.dataUrl).toContain(Buffer.from('stack-old-image').toString('base64'));
      expect(image.newImage?.dataUrl).toContain(Buffer.from('stack-new-image').toString('base64'));
    }
    expect((await requests()).some((endpoint) => endpoint.includes('/pulls/42/files'))).toBe(false);
  });
});

test('retains the stacked image snapshot after the PR advances', async () => {
  await withPullRequest(async ({ host, responses, root, saveResponses, source }) => {
    responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${mergeBase}..${head})`;
    responses.comparison.files = [{ filename: 'image.png', patch: '', status: 'modified' }];
    responses.contents[`repos/acme/widgets/contents/image.png?ref=${mergeBase}`] =
      'stack-old-image';
    responses.contents[`repos/contributor/widgets/contents/image.png?ref=${head}`] =
      'stack-new-image';
    await saveResponses();
    const state = await readPullRequestState(host, root, source);
    responses.metadata.body = '';
    responses.metadata.head.sha = 'd'.repeat(40);
    responses.metadata.head.repo.full_name = 'other/widgets';
    responses.failures['repos/acme/widgets/pulls/42'] = 'HTTP 503: Service Unavailable';
    await saveResponses();
    const image = await readDiffImageContent(host, root, {
      kind: 'pull-request',
      path: 'image.png',
      source: state.source,
    });
    expect(image).toMatchObject({ status: 'ready' });
    if (image.status === 'ready') {
      expect(image.newImage?.dataUrl).toContain(Buffer.from('stack-new-image').toString('base64'));
    }
  });
});

test('lists only incremental commits as PR history and starts base history at the stack parent', async () => {
  await withPullRequest(async ({ host, requests, responses, root, saveResponses, source }) => {
    responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${mergeBase}..${head})`;
    responses.commits[0].unshift({
      commit: { author: { date: '2026-10-13T11:00:00Z' }, message: 'Parent stack change' },
      sha: mergeBase,
    });
    responses.baseCommits[0].sha = mergeBase;
    await saveResponses();
    const history = await listPullRequestHistory(host, root, source, 10);
    expect(history.entries.map(({ ref, scope }) => ({ ref, scope }))).toEqual([
      { ref: head, scope: 'pull-request' },
      { ref: mergeBase, scope: 'base' },
    ]);
    expect((await requests()).some((endpoint) => endpoint.includes('/pulls/42/commits'))).toBe(
      false,
    );
    expect(
      (await requests()).some((endpoint) => endpoint.includes(`/commits?sha=${mergeBase}`)),
    ).toBe(true);
  });
});

test.each(['comment', 'review'])(
  'does not submit an incremental old-side %s using whole-PR line coordinates',
  async (action) => {
    await withPullRequest(async ({ host, requests, responses, root, saveResponses, source }) => {
      responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${mergeBase}..${head})`;
      await saveResponses();
      const comment = {
        body: 'Old line',
        filePath: 'file.txt',
        lineNumber: 2,
        side: 'deletions' as const,
      };
      await expect(
        action === 'comment'
          ? submitPullRequestComment(host, root, { source, comment })
          : submitPullRequestReview(host, root, { source, comments: [comment], event: 'COMMENT' }),
      ).rejects.toThrow(/old.side.*GitHub|GitHub.*old.side/i);
      expect(
        (await requests()).filter((endpoint) => /\/(comments|reviews)$/.test(endpoint)),
      ).toEqual([]);
      const newSideComment = { ...comment, side: 'additions' as const };
      if (action === 'comment') {
        await submitPullRequestComment(host, root, { source, comment: newSideComment });
      } else {
        await submitPullRequestReview(host, root, {
          source,
          comments: [newSideComment],
          event: 'COMMENT',
        });
      }
      expect(
        (await requests()).filter((endpoint) => /\/(comments|reviews)$/.test(endpoint)),
      ).toHaveLength(1);
    });
  },
);

test.each(['comment', 'review'])(
  'rejects a stacked inline %s after its head advances while allowing general reviews',
  async (action) => {
    await withPullRequest(async ({ host, requests, responses, root, saveResponses, source }) => {
      responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${mergeBase}..${head})`;
      await saveResponses();
      const state = await readPullRequestState(host, root, source);
      responses.metadata.head.sha = 'd'.repeat(40);
      await saveResponses();
      const comment = {
        body: 'New line',
        filePath: 'file.txt',
        lineNumber: 2,
        side: 'additions' as const,
      };
      await expect(
        action === 'comment'
          ? submitPullRequestComment(host, root, { source: state.source, comment })
          : submitPullRequestReview(host, root, {
              source: state.source,
              comments: [comment],
              event: 'COMMENT',
            }),
      ).rejects.toThrow(/head.*changed|changed.*head/i);
      expect(
        (await requests()).filter((endpoint) => /\/(comments|reviews)$/.test(endpoint)),
      ).toEqual([]);
      await expect(
        submitPullRequestReview(host, root, {
          source: state.source,
          comments: [],
          body: 'General feedback',
          event: 'COMMENT',
        }),
      ).resolves.toBeUndefined();
    });
  },
);

test('keeps current new-side GitHub comments but omits comments on a different incremental base', async () => {
  await withPullRequest(async ({ host, responses, root, saveResponses, source }) => {
    responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${mergeBase}..${head})`;
    const comment = { body: 'Feedback', path: 'file.txt', line: 2 };
    responses.comments = [
      [
        { ...comment, id: 1, side: 'LEFT' },
        { ...comment, id: 2, side: 'RIGHT' },
        { ...comment, id: 3, side: 'RIGHT', start_line: 1, start_side: 'LEFT' },
      ],
    ];
    await saveResponses();
    const state = await readPullRequestState(host, root, source);
    expect(state.reviewComments?.map((comment) => comment.id)).toEqual(['github:2']);
    responses.metadata.head.sha = 'd'.repeat(40);
    await saveResponses();
    expect((await readPullRequestState(host, root, source)).reviewComments).toEqual([]);
  });
});

test.each(['diverged', 'truncated'])(
  'rejects a %s comparison rather than showing an inexact stacked diff',
  async (failure) => {
    await withPullRequest(async ({ host, responses, root, saveResponses, source }) => {
      responses.metadata.body = `[Files changed](https://github.com/acme/widgets/pull/42/files/${mergeBase}..${head})`;
      if (failure === 'diverged') responses.comparison.merge_base_commit.sha = base;
      else
        responses.comparison.files = Array.from({ length: 300 }, (_, index) => ({
          filename: `file-${index}.txt`,
          status: 'modified',
          patch: '',
        }));
      await saveResponses();
      await expect(readRepositoryState(host, root, source)).rejects.toThrow(
        failure === 'diverged' ? /ancestor/ : /complete file list/,
      );
    });
  },
);

test.each([
  ['metadata', 'repos/acme/widgets/pulls/42'],
  ['changed files', 'repos/acme/widgets/pulls/42/files?per_page=100'],
  ['diff', 'diff'],
  ['review comments', 'repos/acme/widgets/pulls/42/comments?per_page=100'],
])(
  'identifies the PR and failed %s request while preserving the GitHub error',
  async (operation, endpoint) => {
    await withPullRequest(async ({ host, responses, root, saveResponses, source }) => {
      responses.failures[endpoint] =
        'HTTP 403: Resource protected by organization SAML enforcement.';
      await saveResponses();
      const error = await readRepositoryState(host, root, source).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('acme/widgets#42');
      expect((error as Error).message).toContain(operation);
      expect((error as Error).message).toContain(responses.failures[endpoint]);
      expect((error as Error).message).toContain(
        'gh pr view https://github.com/acme/widgets/pull/42',
      );
    });
  },
);

test('keeps generated path detection for PRs without reading local attributes', async () => {
  await withPullRequest(async ({ gitRequests, host, responses, root, saveResponses, source }) => {
    responses.files[0][0].filename = 'pnpm-lock.yaml';
    responses.diff = patch.replaceAll('file.txt', 'pnpm-lock.yaml');
    await saveResponses();
    const state = await readRepositoryState(host, root, source);
    expect(state.files[0]).toMatchObject({ generated: true, path: 'pnpm-lock.yaml' });
    expect(gitRequests.some((args) => ['check-attr', 'read-tree'].includes(args[2]))).toBe(false);
  });
});

test('secondary PR actions use API data without local objects or Git fallback', async () => {
  await withPullRequest(async ({ host, responses, root, saveResponses, source }) => {
    const state = await readRepositoryState(host, root, source);
    const refresh = await readRepositoryState(host, root, state.source);
    expect(refresh.files[0].sections[0].patch).toBe(patch);
    const walkthrough = await readWalkthroughRepositoryState(host, root, source);
    expect(walkthrough.files[0].sections[0].patch).toBe(patch);
    const history = await readRepositoryHistory(host, root, 10, source);
    expect(history.entries).toHaveLength(2);
    for (const entry of history.entries) {
      const commit = await readRepositoryState(host, root, entry.source!);
      expect(commit.files).toHaveLength(1);
    }
    const comment = {
      body: 'Review comment',
      filePath: 'file.txt',
      lineNumber: 2,
      side: 'additions' as const,
    };
    await expect(submitPullRequestComment(host, root, { comment, source })).resolves.toMatchObject({
      body: 'Review comment',
    });
    await submitPullRequestReview(host, root, { comments: [comment], event: 'COMMENT', source });

    responses.files[0][0] = { filename: 'image.png', status: 'modified' };
    responses.commit.files[0].filename = 'image.png';
    responses.contents[`repos/acme/widgets/contents/image.png?ref=${base}`] = 'old-image';
    responses.contents[`repos/acme/widgets/contents/image.png?ref=${mergeBase}`] = 'old-image';
    responses.contents[`repos/contributor/widgets/contents/image.png?ref=${mergeBase}`] =
      'old-image';
    responses.contents[`repos/contributor/widgets/contents/image.png?ref=${head}`] = 'new-image';
    await saveResponses();
    expect(
      await readDiffImageContent(host, root, { kind: 'pull-request', path: 'image.png', source }),
    ).toMatchObject({
      status: 'ready',
      oldImage: { mimeType: 'image/png' },
      newImage: { mimeType: 'image/png' },
    });
    expect(
      await readDiffImageContent(host, root, {
        kind: 'commit',
        path: 'image.png',
        source: history.entries[0].source,
      }),
    ).toMatchObject({
      status: 'ready',
      oldImage: { mimeType: 'image/png' },
      newImage: { mimeType: 'image/png' },
    });

    responses.failures['repos/acme/widgets/pulls/42'] = 'HTTP 503: Service Unavailable';
    await saveResponses();
    await expect(readRepositoryHistory(host, root, 10, source)).rejects.toThrow('HTTP 503');
    expect(
      await readDiffImageContent(host, root, { kind: 'pull-request', path: 'image.png', source }),
    ).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('HTTP 503') });
    await expect(
      submitPullRequestReview(host, root, { comments: [], event: 'APPROVE', source }),
    ).rejects.toThrow('HTTP 503');
  });
});

test('direct generated-file annotation never reads GitHub PR or history objects', async () => {
  const { annotateGeneratedFiles } = require('../generated-files.cjs');
  await withPullRequest(async ({ gitRequests, host, root, source }) => {
    const state = await readPullRequestState(host, root, source);
    state.files[0].path = 'pnpm-lock.yaml';
    for (const reviewSource of [
      state.source,
      { type: 'commit', ref: head, github: { owner: 'contributor', repo: 'widgets' } },
    ]) {
      expect(
        (await annotateGeneratedFiles(host, { ...state, source: reviewSource })).files[0].generated,
      ).toBe(true);
    }
    expect(gitRequests.map((args) => args[2])).toEqual(['rev-parse', 'remote', 'config']);
  });
});

test('loads PR history from GitHub with no local commits or fetches', async () => {
  await withPullRequest(async ({ gitRequests, host, requests, root, source }) => {
    const history = await listPullRequestHistory(host, root, source, 10);
    expect(history.entries.map(({ scope, subject }) => ({ scope, subject }))).toEqual([
      { scope: 'pull-request', subject: 'PR' },
      { scope: 'base', subject: 'Base' },
    ]);
    expect(gitRequests.map((args) => args[2])).toEqual(['rev-parse', 'remote', 'config']);
    expect((await requests()).some((endpoint) => /\/contents\/|\/compare\//.test(endpoint))).toBe(
      false,
    );
  });
});

test('context expansion loads only the requested file from GitHub and caches repeat expansions', async () => {
  await withPullRequest(async ({ host, requests, root, source }) => {
    const state = await readPullRequestState(host, root, source);
    expect(supportsLazyDiffContent(state.source)).toBe(true);
    expect(supportsDiffSearchContentPreload(state.source)).toBe(false);
    const file = state.files[0];
    const section = file.sections[0];
    expect(shouldLoadDiffSectionContents(section)).toBe(false);
    const { fileDiff } = getVisibleDiffSections(file, false)[0];
    expect(fileDiff.isPartial).toBe(true);
    expect(getSectionForFileDiff(fileDiff)).toEqual({ file, section });
    const load = async () => {
      const loaded = await readDiffSectionContent(host, root, {
        kind: 'pull-request',
        path: file.path,
        source: state.source,
      });
      expect(loaded.oldFile?.cacheKey).toContain(mergeBase);
      expect(loaded.newFile?.cacheKey).toContain(head);
      return { newFile: loaded.newFile!, oldFile: loaded.oldFile! };
    };
    const loaded = await loadSectionContents(file, section, load);
    expect(loaded.oldFile?.contents).toBe('unchanged\nbefore\nmore\n');
    expect(loaded.newFile.contents).toBe('unchanged\nafter\nmore\n');
    expect(await loadSectionContents(file, section, load)).toBe(loaded);
    expect((await requests()).filter((endpoint) => endpoint.includes('/contents/')).sort()).toEqual(
      [newEndpoint, oldEndpoint].sort(),
    );
  });
});

test('loads renamed files and retains the PR snapshot when the head advances', async () => {
  await withPullRequest(async ({ host, requests, responses, root, saveResponses, source }) => {
    responses.files[0][0].filename = 'new name.txt';
    responses.files[0][0].previous_filename = 'old name.txt';
    responses.files[0][0].status = 'renamed';
    const oldPath = `repos/acme/widgets/contents/old%20name.txt?ref=${mergeBase}`;
    const newPath = `repos/contributor/widgets/contents/new%20name.txt?ref=${head}`;
    responses.contents = { [oldPath]: 'before\n', [newPath]: 'after\n' };
    await saveResponses();
    const state = await readPullRequestState(host, root, source);
    responses.metadata.head.sha = 'd'.repeat(40);
    responses.metadata.head.repo.full_name = 'other/widgets';
    responses.files = [[{ filename: 'different.txt', status: 'added' }]];
    await saveResponses();
    const section = await readDiffSectionContent(host, root, {
      kind: 'pull-request',
      path: 'new name.txt',
      source: state.source,
      file: { oldPath: 'old name.txt', patch: state.files[0].sections[0].patch, status: 'renamed' },
    });
    expect(section.oldFile).toMatchObject({ contents: 'before\n', name: 'old name.txt' });
    expect(section.newFile).toMatchObject({ contents: 'after\n', name: 'new name.txt' });
    expect((await requests()).filter((endpoint) => endpoint.includes('/contents/')).sort()).toEqual(
      [oldPath, newPath].sort(),
    );
  });
});

test('expands the displayed patch when GitHub omits the per-file patch', async () => {
  await withPullRequest(async ({ host, responses, root, saveResponses, source }) => {
    delete responses.files[0][0].patch;
    await saveResponses();
    const state = await readPullRequestState(host, root, source);
    const section = await readDiffSectionContent(host, root, {
      kind: 'pull-request',
      path: 'file.txt',
      source: state.source,
      file: { patch: state.files[0].sections[0].patch, status: 'modified' },
    });
    expect(section.oldFile?.contents).toBe('unchanged\nbefore\nmore\n');
    expect(section.newFile?.contents).toBe('unchanged\nafter\nmore\n');
    expect(section.binary).toBe(false);
  });
});

test('opens PR history commits and expands their contents through GitHub without local objects', async () => {
  await withPullRequest(async ({ gitRequests, host, requests, root, source }) => {
    const history = await listPullRequestHistory(host, root, source, 10);
    expect(history.entries[0].source).toMatchObject({
      type: 'commit',
      ref: head,
      github: { owner: 'contributor', repo: 'widgets' },
    });
    expect(history.entries[1].source).toMatchObject({
      type: 'commit',
      ref: base,
      github: { owner: 'acme', repo: 'widgets' },
    });
    const state = await readRepositoryState(host, root, history.entries[0].source!);
    expect(state.commitMetadata?.subject).toBe('PR');
    expect(state.files[0].sections[0].newFile).toBeUndefined();
    expect((await requests()).some((endpoint) => endpoint.includes('/contents/'))).toBe(false);
    const section = await readDiffSectionContent(host, root, {
      kind: 'commit',
      path: 'file.txt',
      source: state.source,
      file: { patch: state.files[0].sections[0].patch, status: 'modified' },
    });
    expect(section.oldFile?.contents).toBe('unchanged\nbefore\nmore\n');
    expect(section.newFile?.contents).toBe('unchanged\nafter\nmore\n');
    expect(
      gitRequests.some((args) => ['fetch', 'cat-file', 'ls-tree', 'show'].includes(args[2])),
    ).toBe(false);
  });
});

test.each(['added', 'removed'])(
  'loads %s files without requesting the absent side',
  async (status) => {
    await withPullRequest(async ({ host, requests, responses, root, saveResponses, source }) => {
      responses.files[0][0].status = status;
      await saveResponses();
      const section = await readDiffSectionContent(host, root, {
        kind: 'pull-request',
        path: 'file.txt',
        source,
      });
      expect(section.oldFile?.contents).toBe(status === 'added' ? '' : 'unchanged\nbefore\nmore\n');
      expect(section.newFile?.contents).toBe(
        status === 'removed' ? '' : 'unchanged\nafter\nmore\n',
      );
      expect((await requests()).filter((endpoint) => endpoint.includes('/contents/'))).toEqual([
        status === 'added' ? newEndpoint : oldEndpoint,
      ]);
    });
  },
);

test('rejects missing contents and unlisted paths while preserving the displayed patch', async () => {
  await withPullRequest(async ({ host, responses, root, saveResponses, source }) => {
    const state = await readPullRequestState(host, root, source);
    responses.contents[oldEndpoint] = null;
    await saveResponses();
    await expect(
      readDiffSectionContent(host, root, {
        kind: 'pull-request',
        path: 'file.txt',
        source: state.source,
      }),
    ).rejects.toThrow('could not load');
    await expect(
      readDiffSectionContent(host, root, {
        kind: 'pull-request',
        path: 'unlisted.txt',
        source: state.source,
      }),
    ).rejects.toThrow('not part of this pull request');
    expect(state.files[0].sections[0].patch).toBe(patch);
  });
});

test('expands a validated snapshot after an aliased remote head advances', async () => {
  await withPullRequest(async ({ host, root, source }) => {
    await execFileAsync(
      'git',
      ['-C', root, 'remote', 'set-url', 'origin', 'git@github-work:acme/widgets.git'],
      {
        env: getGitTestEnvironmentForSubprocess(),
      },
    );
    let remoteHead = head;
    let probes = 0;
    const aliasHost: RepositoryHost = {
      ...host,
      exec: (command, args, options) => {
        if (command === 'git' && args[2] === 'ls-remote') {
          probes++;
          return Promise.resolve(Buffer.from(`${remoteHead}\trefs/pull/42/head\n`));
        }
        return host.exec(command, args, options);
      },
    };
    const state = await readPullRequestState(aliasHost, root, source);
    expect(probes).toBe(1);
    remoteHead = 'd'.repeat(40);
    const file = state.files[0];
    const section = await readDiffSectionContent(
      aliasHost,
      root,
      createSectionContentRequest(file, file.sections[0], state.source, false),
    );
    expect(section.oldFile?.contents).toBe('unchanged\nbefore\nmore\n');
    expect(section.newFile?.contents).toBe('unchanged\nafter\nmore\n');
    expect(probes).toBe(1);
  });
});
