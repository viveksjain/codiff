import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, test } from 'vite-plus/test';
import type { RepositoryHost } from '../../electron/host/repository-host.cjs';
import type { RepositoryState, ReviewSource } from '../types.ts';

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
