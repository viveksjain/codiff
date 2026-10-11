import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vite-plus/test';
import {
  getGitTestEnvironmentForSubprocess,
  withGitTestEnvironment,
} from '../../core/__tests__/helpers/git.ts';
import { createRecordingHost } from '../../core/__tests__/helpers/recording-host.ts';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';
import { host } from '../../core/__tests__/helpers/test-host.ts';
import type { RepositoryHost } from '../host/repository-host.cjs';

const require = createRequire(import.meta.url);
const { createWalkthroughCommit } = require('../walkthrough-commit.cjs') as {
  createWalkthroughCommit: (
    host: RepositoryHost,
    repoPath: string,
    request: { body?: string; paths?: ReadonlyArray<string>; subject?: string },
    onOutput?: (chunk: string) => void,
  ) => Promise<{ hash: string; status: 'committed' } | { reason: string; status: 'failed' }>;
};

const execFileAsync = promisify(execFile);

const git = async (repoPath: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironmentForSubprocess(),
  });
  return stdout;
};

const withRepo = async (testBody: (repoPath: string) => Promise<void>) => {
  await withGitTestEnvironment(async () => {
    await using directory = await createTemporaryDirectory('codiff-walkthrough-commit-');
    await git(directory.path, ['init']);
    await testBody(directory.path);
  });
};

test('rejects a commit with no subject before touching git', async () => {
  const result = await createWalkthroughCommit(host, '/repo', {
    paths: ['src/App.tsx'],
    subject: '   ',
  });
  expect(result.status).toBe('failed');
});

test('rejects a commit with no selected files', async () => {
  const result = await createWalkthroughCommit(host, '/repo', { paths: [], subject: 'Fix it' });
  expect(result.status).toBe('failed');
});

test('rejects a path that escapes the repository', async () => {
  const result = await createWalkthroughCommit(host, '/repo', {
    paths: ['../../etc/passwd'],
    subject: 'Fix it',
  });
  expect(result).toEqual({ reason: 'A selected file path is invalid.', status: 'failed' });
});

test('commits only selected files and leaves unrelated staged files alone', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'selected.txt'), 'before\n');
    await writeFile(join(repoPath, 'other.txt'), 'before\n');
    await git(repoPath, ['add', 'selected.txt', 'other.txt']);
    await git(repoPath, ['commit', '-m', 'Initial commit']);

    await writeFile(join(repoPath, 'selected.txt'), 'after\n');
    await writeFile(join(repoPath, 'other.txt'), 'after\n');
    await git(repoPath, ['add', 'other.txt']);

    const result = await createWalkthroughCommit(host, repoPath, {
      body: 'Body line',
      paths: ['selected.txt'],
      subject: 'Update selected',
    });

    expect(result.status).toBe('committed');
    expect(await git(repoPath, ['show', '--format=%B', '--no-patch', 'HEAD'])).toBe(
      'Update selected\n\nBody line\n\n',
    );
    expect(await git(repoPath, ['show', '--format=', '--name-only', 'HEAD'])).toBe(
      'selected.txt\n',
    );
    expect(await git(repoPath, ['diff', '--name-only', '--cached'])).toBe('other.txt\n');
  });
});

test('streams hook output and returns stripped failure text', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'example.txt'), 'before\n');
    await git(repoPath, ['add', 'example.txt']);
    await git(repoPath, ['commit', '-m', 'Initial commit']);
    await writeFile(
      join(repoPath, '.git/hooks/pre-commit'),
      [
        '#!/bin/sh',
        'printf "\\033[31mhook started\\033[0m\\n"',
        'printf "hook failed\\n"',
        'exit 1',
        '',
      ].join('\n'),
    );
    await chmod(join(repoPath, '.git/hooks/pre-commit'), 0o755);
    await writeFile(join(repoPath, 'example.txt'), 'after\n');
    await using _localHooks = createTemporaryEnvironment({
      GIT_CONFIG_VALUE_3: join(repoPath, '.git/hooks'),
    });

    const output: Array<string> = [];
    const result = await createWalkthroughCommit(
      host,
      repoPath,
      {
        paths: ['example.txt'],
        subject: 'Update example',
      },
      (chunk) => output.push(chunk),
    );

    expect(output.join('')).toContain('hook started');
    expect(result).toEqual({
      reason: 'hook started\nhook failed',
      status: 'failed',
    });
    expect(await readFile(join(repoPath, 'example.txt'), 'utf8')).toBe('after\n');
  });
});

test('commits through the host and preserves the exact message', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'a.txt'), 'a\n');
    const { calls, host: recordingHost } = createRecordingHost(host);
    const subject = `Fix "quoted" $HOME \`thing\` — naïve café`;
    const body = "# not a comment line\nIt's 'single' and \"double\".\n\nSecond paragraph.";
    const result = await createWalkthroughCommit(recordingHost, repoPath, {
      body,
      paths: ['a.txt'],
      subject,
    });

    expect(result.status).toBe('committed');
    // `git commit -F <file>` uses the `whitespace` cleanup mode, which keeps `#`
    // lines and only trims surrounding blank lines.
    expect((await git(repoPath, ['log', '-1', '--format=%B'])).trimEnd()).toBe(
      `${subject}\n\n${body}`,
    );
    expect(calls.some(({ method }) => method === 'spawnPty')).toBe(true);
    expect(calls.some(({ method }) => method === 'mkdtemp')).toBe(true);
    expect(calls.some(({ method }) => method === 'rm')).toBe(true);
  });
});

test('a cleanup failure does not turn a successful commit into a failure', async () => {
  await withRepo(async (repoPath) => {
    await writeFile(join(repoPath, 'a.txt'), 'a\n');
    const result = await createWalkthroughCommit(
      { ...host, rm: () => Promise.reject(new Error('cleanup failed')) },
      repoPath,
      { paths: ['a.txt'], subject: 'Add a.' },
    );
    expect(result.status).toBe('committed');
    expect((await git(repoPath, ['log', '-1', '--format=%s'])).trim()).toBe('Add a.');
  });
});
