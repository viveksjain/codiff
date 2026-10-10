import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import { getGitTestEnvironment } from '../../core/__tests__/helpers/git.ts';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { RepositoryHost } from '../host/repository-host.cjs';

const require = createRequire(import.meta.url);
const { createLocalHost } = require('../host/local-host.cjs') as {
  createLocalHost: () => RepositoryHost;
};
const host = createLocalHost();

type ReviewRemote = {
  direction: string;
  host: string;
  name: string;
  projectPath: string;
  provider: 'github' | 'gitlab';
};

const {
  parseRemoteUrl,
  parseReviewRemotes,
  parseReviewUrl,
  readReviewRemotes,
  resolveReviewUrl,
  selectReviewUrl,
} = require('../review-source.cjs') as {
  parseRemoteUrl: (value: string) => {
    host: string;
    projectPath: string;
    provider: 'github' | 'gitlab';
  } | null;
  parseReviewUrl: (value: string) => {
    host: string;
    number: number;
    owner?: string;
    projectPath: string;
    provider: 'github' | 'gitlab';
    repo?: string;
    url: string;
  } | null;
  parseReviewRemotes: (raw: string) => Array<ReviewRemote>;
  readReviewRemotes: (host: RepositoryHost, repositoryPath: string) => Promise<Array<ReviewRemote>>;
  resolveReviewUrl: (
    host: RepositoryHost,
    repositoryPath: string,
    number: number,
    provider?: 'github' | 'gitlab',
  ) => Promise<string>;
  selectReviewUrl: (
    remotes: ReadonlyArray<ReviewRemote>,
    number: number,
    provider?: 'github' | 'gitlab',
  ) => string;
};

const execFileAsync = promisify(execFile);

const git = async (repo: string, args: ReadonlyArray<string>) =>
  (
    await execFileAsync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: getGitTestEnvironment(),
    })
  ).stdout.trim();

test('parseReviewUrl reads canonical GitHub pull request URLs', () => {
  expect(parseReviewUrl('https://github.com/nkzw-tech/codiff/pull/1728')).toEqual({
    host: 'github.com',
    number: 1728,
    owner: 'nkzw-tech',
    projectPath: 'nkzw-tech/codiff',
    provider: 'github',
    repo: 'codiff',
    url: 'https://github.com/nkzw-tech/codiff/pull/1728',
  });
});

test('parseReviewUrl ignores GitHub tab segments, queries and fragments', () => {
  for (const value of [
    'https://github.com/nkzw-tech/codiff/pull/1728/',
    'https://github.com/nkzw-tech/codiff/pull/1728/changes#r2231',
    'https://github.com/nkzw-tech/codiff/pull/1728/files',
    'https://github.com/nkzw-tech/codiff/pull/1728/files#diff-8a1b2c',
    'https://github.com/nkzw-tech/codiff/pull/1728/commits/0f1e2d3c',
    'https://github.com/nkzw-tech/codiff/pull/1728?diff=split&w=1',
    'https://github.com/nkzw-tech/codiff/pull/1728#issuecomment-4412',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 1728,
      provider: 'github',
      url: 'https://github.com/nkzw-tech/codiff/pull/1728',
    });
  }
});

test('parseReviewUrl accepts GitHub URLs pasted without a scheme or with `www`', () => {
  for (const value of [
    'github.com/nkzw-tech/codiff/pull/1728/changes',
    'www.github.com/nkzw-tech/codiff/pull/1728',
    'https://www.github.com/nkzw-tech/codiff/pull/1728/files',
    'HTTPS://GitHub.com/nkzw-tech/codiff/pull/1728',
    '<https://github.com/nkzw-tech/codiff/pull/1728>',
    '  https://github.com/nkzw-tech/codiff/pull/1728/files  ',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      host: 'github.com',
      number: 1728,
      owner: 'nkzw-tech',
      repo: 'codiff',
      url: 'https://github.com/nkzw-tech/codiff/pull/1728',
    });
  }
});

test('parseReviewUrl strips a `.git` suffix from GitHub repositories', () => {
  expect(parseReviewUrl('https://github.com/nkzw-tech/codiff.git/pull/1728')).toMatchObject({
    projectPath: 'nkzw-tech/codiff',
    repo: 'codiff',
    url: 'https://github.com/nkzw-tech/codiff/pull/1728',
  });
});

test('parseReviewUrl reads GitLab merge request URLs on arbitrary hosts', () => {
  expect(
    parseReviewUrl('https://gitlab.example.com/group/subgroup/project/-/merge_requests/23'),
  ).toEqual({
    host: 'gitlab.example.com',
    number: 23,
    projectPath: 'group/subgroup/project',
    provider: 'gitlab',
    url: 'https://gitlab.example.com/group/subgroup/project/-/merge_requests/23',
  });
});

test('parseReviewUrl ignores GitLab tab segments, queries and fragments', () => {
  for (const value of [
    'https://gitlab.example.com/group/project/-/merge_requests/23/',
    'https://gitlab.example.com/group/project/-/merge_requests/23/diffs',
    'https://gitlab.example.com/group/project/-/merge_requests/23/diffs#note_9182',
    'https://gitlab.example.com/group/project/-/merge_requests/23/commits',
    'https://gitlab.example.com/group/project/-/merge_requests/23/pipelines',
    'https://gitlab.example.com/group/project/-/merge_requests/23?commit_id=0f1e2d3c',
    'gitlab.example.com/group/project/-/merge_requests/23/diffs',
  ]) {
    expect(parseReviewUrl(value)).toMatchObject({
      number: 23,
      projectPath: 'group/project',
      provider: 'gitlab',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
    });
  }
});

test('parseReviewUrl reads legacy GitLab merge request URLs without the `/-/` segment', () => {
  expect(
    parseReviewUrl('https://gitlab.example.com/group/project/merge_requests/23/diffs'),
  ).toMatchObject({
    number: 23,
    projectPath: 'group/project',
    provider: 'gitlab',
    url: 'https://gitlab.example.com/group/project/-/merge_requests/23',
  });
});

test('parseReviewUrl rejects values that are not review URLs', () => {
  for (const value of [
    '',
    'main',
    'feature/pull/1',
    'https://github.com/nkzw-tech/codiff',
    'https://github.com/nkzw-tech/codiff/pull/0',
    'https://github.com/nkzw-tech/codiff/pull/abc',
    'https://github.com/nkzw-tech/codiff/issues/1728',
    'https://example.com/nkzw-tech/codiff/pull/1728',
    'some/local/path/merge_requests/23',
  ]) {
    expect(parseReviewUrl(value)).toBe(null);
  }
});

test('parseRemoteUrl drops a custom port from `ssh://` remotes', () => {
  expect(parseRemoteUrl('ssh://git@gitlab.example.com:2222/group/project.git')).toEqual({
    host: 'gitlab.example.com',
    projectPath: 'group/project',
    provider: 'gitlab',
  });
});

test('parseRemoteUrl keeps an explicit port on `https://` remotes', () => {
  expect(parseRemoteUrl('https://gitlab.example.com:8443/group/subgroup/project.git')).toEqual({
    host: 'gitlab.example.com:8443',
    projectPath: 'group/subgroup/project',
    provider: 'gitlab',
  });
});

test('parseRemoteUrl reads scp-style and GitHub remotes', () => {
  expect(parseRemoteUrl('git@gitlab.example.com:group/project.git')).toEqual({
    host: 'gitlab.example.com',
    projectPath: 'group/project',
    provider: 'gitlab',
  });
  expect(parseRemoteUrl('https://github.com/nkzw-tech/codiff.git')).toEqual({
    host: 'github.com',
    projectPath: 'nkzw-tech/codiff',
    provider: 'github',
  });
});

test('parseReviewRemotes and selectReviewUrl resolve a review without Git', () => {
  const remotes = parseReviewRemotes(
    'origin\tgit@github.com:nkzw-tech/codiff.git (fetch)\norigin\tgit@github.com:nkzw-tech/codiff.git (push)\n',
  );
  expect(selectReviewUrl(remotes, 12)).toBe('https://github.com/nkzw-tech/codiff/pull/12');
  expect(() => selectReviewUrl([], 12)).toThrow('Could not resolve review #12');
});

test('readReviewRemotes and resolveReviewUrl read remotes through the repository host', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-remotes-');
  await git(directory.path, ['init']);
  await git(directory.path, [
    'remote',
    'add',
    'upstream',
    'https://github.com/upstream/codiff.git',
  ]);
  await git(directory.path, [
    'remote',
    'add',
    'origin',
    'git@gitlab.example.com:group/project.git',
  ]);

  expect(await readReviewRemotes(host, directory.path)).toContainEqual({
    direction: 'fetch',
    host: 'gitlab.example.com',
    name: 'origin',
    projectPath: 'group/project',
    provider: 'gitlab',
  });
  expect(await resolveReviewUrl(host, directory.path, 7)).toBe(
    'https://gitlab.example.com/group/project/-/merge_requests/7',
  );
  expect(await resolveReviewUrl(host, directory.path, 7, 'github')).toBe(
    'https://github.com/upstream/codiff/pull/7',
  );
});

test('resolveReviewUrl explains how to recover outside a Git repository', async () => {
  await using directory = await createTemporaryDirectory('codiff-review-remotes-');
  await expect(resolveReviewUrl(host, directory.path, 7)).rejects.toThrow(
    'Could not resolve review #7. Run codiff inside a Git repository',
  );
});
