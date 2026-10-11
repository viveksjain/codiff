import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, test } from 'vite-plus/test';
import {
  findSshd,
  startTestSshd,
  type TestSshd,
} from '../../electron/__tests__/helpers/test-sshd.ts';
import type { RepositoryHost } from '../../electron/host/repository-host.cjs';
import type { RepositoryState, ReviewSource } from '../types.ts';
import { getGitTestEnvironmentForSubprocess } from './helpers/git.ts';

type GitStateModule = {
  readRepositoryState: (
    host: RepositoryHost,
    launchPath: string,
    source?: ReviewSource,
  ) => Promise<RepositoryState>;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { createLocalHost } = require('../../electron/host/local-host.cjs') as {
  createLocalHost: () => RepositoryHost;
};
const host = createLocalHost();
const { readRepositoryState } = require('../../electron/git-state.cjs') as GitStateModule;

const FILE_COUNT = 160;

let commit = '';
let repo = '';

const git = async (repository: string, args: ReadonlyArray<string>) => {
  const { stdout } = await execFileAsync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: getGitTestEnvironmentForSubprocess(),
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
};

const writeRepoFile = async (repository: string, path: string, contents: string) => {
  const absolutePath = join(repository, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
};

const commitAll = async (repository: string, message: string) => {
  await git(repository, ['add', '--all']);
  await git(repository, ['commit', '-m', message]);
};

describe('commit diff generation duration', () => {
  beforeAll(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), 'codiff-git-state-bench-')));
    await git(repo, ['init']);
    await git(repo, ['config', 'user.email', 'codiff@example.com']);
    await git(repo, ['config', 'user.name', 'Codiff Test']);

    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, index) =>
        writeRepoFile(
          repo,
          `src/module-${index.toString().padStart(3, '0')}.ts`,
          Array.from({ length: 80 }, (__, line) => `export const value${line} = ${line};`).join(
            '\n',
          ) + '\n',
        ),
      ),
    );
    await commitAll(repo, 'initial commit');

    await Promise.all(
      Array.from({ length: FILE_COUNT }, (_, index) =>
        writeRepoFile(
          repo,
          `src/module-${index.toString().padStart(3, '0')}.ts`,
          Array.from(
            { length: 100 },
            (__, line) => `export const value${line} = ${line + index};`,
          ).join('\n') + '\n',
        ),
      ),
    );
    await commitAll(repo, 'large history commit');
    commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  });

  afterAll(async () => {
    if (repo) {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test(`readRepositoryState for ${FILE_COUNT} changed files`, async ({ bench }) => {
    await bench('readRepositoryState', async () => {
      const state = await readRepositoryState(host, repo, {
        ref: commit,
        type: 'commit',
      });

      if (state.files.length !== FILE_COUNT) {
        throw new Error(`Expected ${FILE_COUNT} files, received ${state.files.length}.`);
      }
    }).run();
  });
});

const readUntrackedState = async (repositoryHost: RepositoryHost, repository: string) => {
  const state = await readRepositoryState(repositoryHost, repository);
  if (state.files.length !== 1000 || state.files.some((file) => file.status !== 'untracked')) {
    throw new Error('Expected exactly1000 untracked files.');
  }
};

describe.skipIf(!findSshd())('1000 untracked files status over local and SSH hosts', () => {
  let repository = '';
  let sshd: TestSshd | undefined;
  let sshHost: (RepositoryHost & { close: () => Promise<void> }) | undefined;
  beforeAll(async () => {
    repository = await realpath(await mkdtemp(join(tmpdir(), 'codiff-untracked-bench-')));
    await git(repository, ['init']);
    await writeRepoFile(repository, 'tracked.txt', 'baseline\n');
    await commitAll(repository, 'baseline');
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        writeRepoFile(
          repository,
          `untracked/file-${index.toString().padStart(4, '0')}.txt`,
          `${index}\n`,
        ),
      ),
    );
    sshd = await startTestSshd();
    const { connectSshHost } = require('../../electron/host/ssh-host.cjs');
    sshHost = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
  });
  afterAll(async () => {
    try {
      await sshHost?.close();
    } finally {
      try {
        await sshd?.stop();
      } finally {
        if (repository) {
          await rm(repository, { force: true, recursive: true });
        }
      }
    }
  });
  test('compare equivalent warmed repository status reads', async ({ bench }) => {
    if (!sshHost) {
      throw new Error('SSH fixture did not initialize.');
    }
    const remote = sshHost;
    await readUntrackedState(host, repository);
    await readUntrackedState(remote, repository);
    const results = await bench.compare(
      bench('LocalHost:1000 untracked files', () => readUntrackedState(host, repository)),
      bench('SshHost(localhost):1000 untracked files', () =>
        readUntrackedState(remote, repository)),
      { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 },
    );
    const local = results.get('LocalHost:1000 untracked files').latency.p50;
    const ssh = results.get('SshHost(localhost):1000 untracked files').latency.p50;
    const summary = JSON.stringify({
      fixture: '1000-untracked-files',
      localMedianMs: local,
      ratio: ssh / local,
      sshMedianMs: ssh,
      targetRatio: 2,
    });
    const summaryPath = join(process.cwd(), '.superpowers/benchmarks/ssh-status.json');
    await mkdir(dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, summary + '\n');
    process.stdout.write(summary + '\n');
  }, 120_000);
});
