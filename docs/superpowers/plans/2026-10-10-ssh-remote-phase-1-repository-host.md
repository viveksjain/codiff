# SSH Remote Repositories, Phase 1: `RepositoryHost` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every repository operation in Codiff's main process through an explicit `RepositoryHost` object, implemented today by `LocalHost`, with no user-visible behavior change.

**Architecture:** A `RepositoryHost` interface (JSDoc typedefs in `electron/host/repository-host.cjs`) exposes process execution and file-system primitives. `LocalHost` (`electron/host/local-host.cjs`) implements it with `node:child_process`, `node-pty` and `node:fs`. Every function that touches a repository takes `host` as its first parameter; `main.cjs` creates one `LocalHost` at startup and stores a `{host, repositoryPath}` pair per window. Later phases add `SshHost` behind the same interface.

**Tech Stack:** Node.js 24 CommonJS with `// @ts-check` JSDoc types, Electron main process, Vite+ (`vp`) for checks and tests (Vitest API via `vite-plus/test`).

**Spec:** `docs/superpowers/specs/2026-10-10-ssh-remote-repositories-design.md` (this plan implements delivery phase 1 of 5).

## Global Constraints

- No user-visible behavior change for local repositories in this phase. Every existing test must keep passing with the same assertions (only call signatures change).
- The host is passed explicitly as the **first parameter**. No global host getter, no lookup by path, no default parameter that silently supplies a host below the IPC layer.
- `main.cjs` creates exactly one `LocalHost` at startup; nothing below the IPC handlers constructs a host.
- `HostExecOptions.env` / `HostSpawnOptions.env` / `HostPtyOptions.env` mean **extra variables merged over the host's own environment**, never a full replacement. `LocalHost` merges over `process.env` at call time.
- Window identity keys, walkthrough cache keys and `lastRepositoryPath` stay byte-for-byte unchanged for local repositories (so existing caches and windows keep matching). Host-qualified keys arrive in phase 3.
- CLI argument parsing (`bin/arguments.js`, `electron/main/command-line.cjs`) keeps its synchronous local `git` classification in this phase; it runs on the laptop before any host exists. Phase 3 changes it for remote targets.
- Agent runners (`claude.cjs`, `codex.cjs`, `opencode.cjs`, `pi.cjs`) and session-context readers are not threaded in this phase (phase 4).
- Platforms: macOS and Linux behavior must be unchanged; Windows local behavior must also be unchanged (do not hard-code POSIX paths for `LocalHost`).
- Code style: match surrounding code (`// @ts-check`, JSDoc `@param`/`@returns`, `const` arrow functions, single quotes, no new dependencies). Prefer Phosphor icons for any UI (none expected in this phase).
- After each task's code change: run `vp check --fix`, then `vpr build` (per `AGENTS.md`).
- Commits go on the current branch. Commit messages are a single sentence ending with a period (repository style, e.g. `Add a "ship" script.`). Do **not** add `Co-Authored-By` or any AI attribution trailer.

## Spec deviations made while planning (approved alongside this plan)

1. **Commit message transport.** The spec said `git commit -F -` over stdin. Commits run inside a PTY so hook output streams with colors, and the PTY is the process's stdin, so a message written to it would be echoed and mangled. Instead the message file is created on the repository's host with `host.mkdtemp()` + `host.writeFile()` and passed as `-F <path>`. This works unchanged for `SshHost`.
2. **Interface additions.** `stat`, `realpath`, `rename`, `rm`, `writeFile` options (`exclusive`, `mode`) and a separate `spawnPty` method (instead of `spawn({pty: true})`) are needed by `repository-file.cjs` and `walkthrough-commit.cjs`. `HostStat` carries `mode`, `mtimeMs`, `ctimeMs` and `ino` because the repository watcher fingerprints them; phase 2's `SshHost.lstat` must therefore use a GNU/BSD-aware `stat` invocation instead of the spec's `test`/`wc -c` approach.
3. **Deferred methods.** `readdir`, `readFileTail`, `getEnvironment` and `resolveCommand` are only used by walkthroughs and are added in phase 4.

## Review Focus

1. **IPC handlers no test exercises** (`resolvePullRequestUrl`, `getDiffImageContent`, `submitPullRequestReview`, `getRepositoryFile`): a missed call site would throw `TypeError` only when a user clicks. Expected: every handler takes `{host, repositoryPath}` from `windowRepositories.get(id)`. Pinned by the type-check gate in Task 3 and the `window-repositories` tests in Task 2.
2. **Git failure messages shown to users** (commit failure reasons, image load errors): expected byte-identical text. `LocalHost.exec` without input must reject with Node's original `execFile` error (`Command failed: …`). Pinned in Task 1 (`local-host.test.ts`).
3. **Large or special untracked files** (100 MB binary, symlink to `/etc`): expected never read into memory beyond today's limits, symlinks shown as their target text, not followed. Pinned in Task 5 (prefetch skips oversized files and symlinks).
4. **Abort and timeout of `git grep`** after moving to `host.spawn`: expected the child is killed and the promise rejects exactly as today. Pinned in Task 6 (existing definition-search tests run against a fake host).
5. **Commit messages with quotes, `#` lines, trailing whitespace or non-ASCII:** expected the commit message is exactly the subject plus body as today. Pinned in Task 7.

---

## File Structure

| File                                                                                                                                     | Status | Responsibility                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `electron/host/repository-host.cjs`                                                                                                      | Create | JSDoc typedefs for `RepositoryHost`, `HostStat` and option types. No runtime code beyond `module.exports = {}`.      |
| `electron/host/local-host.cjs`                                                                                                           | Create | `createLocalHost()`: `RepositoryHost` over `child_process`, `node-pty`, `fs`.                                        |
| `electron/window-repositories.cjs`                                                                                                       | Create | Per-window `{host, repositoryPath}` registry with launch-path fallback.                                              |
| `electron/__tests__/helpers/repository-host-contract.ts`                                                                                 | Create | Shared contract suite every `RepositoryHost` implementation must pass.                                               |
| `electron/__tests__/local-host.test.ts`                                                                                                  | Create | Runs the contract against `LocalHost`, plus local-only behavior.                                                     |
| `electron/__tests__/window-repositories.test.ts`                                                                                         | Create | Registry tests.                                                                                                      |
| `core/__tests__/helpers/recording-host.ts`                                                                                               | Create | Wraps a host and records method calls for tests.                                                                     |
| `electron/__tests__/repository-host-boundary.test.ts`                                                                                    | Create | Guardrail: repository modules may not import `fs`, `child_process`, `os` or `pty`.                                   |
| `electron/git-state/common.cjs`                                                                                                          | Modify | `git`, `gitBuffer`, `gitBufferWithInput`, `gitOrEmpty` and file readers take `host`; add `prefetchWorkingTreeFiles`. |
| `electron/git-state/{commit,commit-metadata,comparison,git-files,working-tree,pull-request,merge-request}.cjs`, `electron/git-state.cjs` | Modify | Thread `host`.                                                                                                       |
| `electron/generated-files.cjs`                                                                                                           | Modify | Thread `host`; temp index via `host.mkdtemp`.                                                                        |
| `electron/repository-watcher.cjs`                                                                                                        | Modify | Thread `host`; batched `lstatMany`; coordinator keyed by host and root.                                              |
| `electron/definition-search.cjs`                                                                                                         | Modify | Thread `host`; `git grep` via `host.spawn`.                                                                          |
| `electron/walkthrough-commit.cjs`                                                                                                        | Modify | Thread `host`; PTY via `host.spawnPty`; message file on the host.                                                    |
| `electron/repository-file.cjs`                                                                                                           | Modify | Thread `host`; all file operations via host.                                                                         |
| `electron/review-source.cjs`                                                                                                             | Modify | Pure remote parsing plus async `readReviewRemotes(host, path)`; sync local reader kept for CLI parsing.              |
| `electron/window-identity.cjs`                                                                                                           | Modify | Async, host-based repository resolution.                                                                             |
| `electron/main.cjs`                                                                                                                      | Modify | Create `LocalHost`, use `window-repositories`, pass host everywhere, async window identity.                          |
| Existing tests listed per task                                                                                                           | Modify | Pass `host` to changed functions.                                                                                    |

---

### Task 1: `RepositoryHost` types, `LocalHost` and the contract suite

**Files:**

- Create: `electron/host/repository-host.cjs`
- Create: `electron/host/local-host.cjs`
- Create: `electron/__tests__/helpers/repository-host-contract.ts`
- Create: `electron/__tests__/local-host.test.ts`

**Interfaces:**

- Consumes: `spawnPty` from `electron/pty.cjs` (existing).
- Produces:
  - `RepositoryHost`, `HostStat`, `HostFileType`, `HostExecOptions`, `HostSpawnOptions`, `HostPtyOptions`, `HostWriteFileOptions` typedefs, importable from TS as `import type { RepositoryHost } from '../host/repository-host.cjs'` (adjust relative path).
  - `createLocalHost(): RepositoryHost` from `electron/host/local-host.cjs`.
  - `defineRepositoryHostContract(name: string, createFixture: () => Promise<HostFixture>): void` and `type HostFixture = { host: RepositoryHost; root: string; [Symbol.asyncDispose](): Promise<void> }` from the contract helper.

- [ ] **Step 1: Preflight the toolchain and record the baseline**

Install Vite+ from https://viteplus.dev/ if `vp` is not on `PATH`, then from the repository root:

```bash
vp install
vp run build
vp test
```

Expected: all tests pass. If any test fails before you change anything, stop and report it; do not continue on a red baseline.

- [ ] **Step 2: Determine the type-check command for `electron/*.cjs`**

`vite.config.ts` excludes `electron/` from lint, so confirm whether `vp check` type-checks those files. Temporarily append this line to `electron/pty.cjs`:

```js
/** @type {number} */ const codiffTypecheckProbe = 'not a number';
```

Run `vp check`. If the output reports an error in `electron/pty.cjs`, the type-check command for this plan is `vp check`. Otherwise run `vp exec tsc --noEmit -p tsconfig.json`; it must report the probe error, and that becomes the type-check command. Remove the probe line and confirm the chosen command is clean. Every later "Run the type-check" step means this command; write it down in the task notes.

- [ ] **Step 3: Write the typedef module**

Create `electron/host/repository-host.cjs`:

```js
// @ts-check

/**
 * The only way repository code reaches the machine a repository lives on.
 * Implementations: `LocalHost` (this machine) and, in a later phase, `SshHost`.
 * Paths passed to a host are absolute paths on that host's machine.
 *
 * `env` options add variables on top of the host's own environment; they never
 * replace it.
 *
 * @typedef {'directory' | 'file' | 'other' | 'symlink'} HostFileType
 * @typedef {{
 *   ctimeMs: number;
 *   ino: number;
 *   mode: number;
 *   mtimeMs: number;
 *   size: number;
 *   type: HostFileType;
 * }} HostStat
 * @typedef {{
 *   cwd?: string;
 *   env?: Readonly<Record<string, string>>;
 *   input?: string | Buffer;
 *   maxBuffer?: number;
 *   signal?: AbortSignal;
 * }} HostExecOptions
 * @typedef {{
 *   cwd?: string;
 *   env?: Readonly<Record<string, string>>;
 * }} HostSpawnOptions
 * @typedef {{
 *   cols: number;
 *   cwd?: string;
 *   env?: Readonly<Record<string, string>>;
 *   name: string;
 *   rows: number;
 * }} HostPtyOptions
 * @typedef {{exclusive?: boolean; mode?: number}} HostWriteFileOptions
 * @typedef {{
 *   id: string;
 *   label: string;
 *   exec: (command: string, args: ReadonlyArray<string>, options?: HostExecOptions) => Promise<Buffer>;
 *   spawn: (command: string, args: ReadonlyArray<string>, options?: HostSpawnOptions) => import('node:child_process').ChildProcessWithoutNullStreams;
 *   spawnPty: (command: string, args: ReadonlyArray<string>, options: HostPtyOptions) => import('node-pty').IPty;
 *   lstat: (path: string) => Promise<HostStat>;
 *   stat: (path: string) => Promise<HostStat>;
 *   lstatMany: (paths: ReadonlyArray<string>) => Promise<Array<HostStat | null>>;
 *   readFile: (path: string) => Promise<Buffer>;
 *   readFiles: (paths: ReadonlyArray<string>) => Promise<Array<Buffer | Error>>;
 *   readlink: (path: string) => Promise<string>;
 *   realpath: (path: string) => Promise<string>;
 *   writeFile: (path: string, contents: string | Buffer, options?: HostWriteFileOptions) => Promise<void>;
 *   rename: (from: string, to: string) => Promise<void>;
 *   rm: (path: string, options?: {force?: boolean; recursive?: boolean}) => Promise<void>;
 *   mkdtemp: (prefix: string) => Promise<string>;
 * }} RepositoryHost
 */

module.exports = {};
```

- [ ] **Step 4: Write the contract suite**

Create `electron/__tests__/helpers/repository-host-contract.ts`:

```ts
import { basename, join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../../host/repository-host.cjs';

export type HostFixture = {
  host: RepositoryHost;
  // A fresh, empty directory on the host's machine.
  root: string;
  [Symbol.asyncDispose](): Promise<void>;
};

const collect = (
  child: ReturnType<RepositoryHost['spawn']>,
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
  new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr, stdout }));
    child.stdin.end();
  });

const createEntries = async ({ host, root }: HostFixture) => {
  await host.writeFile(join(root, 'file.txt'), 'hello');
  await host.exec('mkdir', [join(root, 'dir')]);
  await host.exec('ln', ['-s', 'file.txt', join(root, 'link')]);
};

export const defineRepositoryHostContract = (
  name: string,
  createFixture: () => Promise<HostFixture>,
) => {
  test(`${name}: exec returns stdout as a Buffer`, async () => {
    await using fixture = await createFixture();
    const output = await fixture.host.exec('printf', ['%s', 'héllo wörld']);
    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.toString('utf8')).toBe('héllo wörld');
  });

  test(`${name}: exec passes binary input through unchanged`, async () => {
    await using fixture = await createFixture();
    const input = Buffer.from([0, 1, 10, 13, 254, 255]);
    expect((await fixture.host.exec('cat', [], { input })).equals(input)).toBe(true);
  });

  test(`${name}: exec rejects with stderr when a command with input fails`, async () => {
    await using fixture = await createFixture();
    await expect(
      fixture.host.exec('/bin/sh', ['-c', 'echo boom >&2; exit 3'], { input: '' }),
    ).rejects.toThrow('boom');
  });

  test(`${name}: exec rejects when a command without input fails`, async () => {
    await using fixture = await createFixture();
    await expect(fixture.host.exec('/bin/sh', ['-c', 'exit 3'])).rejects.toThrow();
  });

  test(`${name}: exec runs in cwd and adds env on top of the host environment`, async () => {
    await using fixture = await createFixture();
    const output = await fixture.host.exec(
      '/bin/sh',
      [
        '-c',
        'pwd -P; printf "%s\\n" "$CODIFF_HOST_TEST"; command -v git >/dev/null && echo has-path',
      ],
      { cwd: fixture.root, env: { CODIFF_HOST_TEST: 'value with spaces' } },
    );
    expect(output.toString('utf8').trim().split('\n')).toEqual([
      await fixture.host.realpath(fixture.root),
      'value with spaces',
      'has-path',
    ]);
  });

  test(`${name}: exec rejects when aborted`, async () => {
    await using fixture = await createFixture();
    const controller = new AbortController();
    const started = Date.now();
    const result = fixture.host.exec('sleep', ['5'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(result).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test(`${name}: spawn streams output and reports the exit code`, async () => {
    await using fixture = await createFixture();
    const result = await collect(
      fixture.host.spawn('/bin/sh', ['-c', 'printf out; printf err >&2; exit 4']),
    );
    expect(result).toEqual({ code: 4, stderr: 'err', stdout: 'out' });
  });

  test(`${name}: lstat and stat report types, sizes and metadata`, async () => {
    await using fixture = await createFixture();
    await createEntries(fixture);
    const { host, root } = fixture;
    const file = await host.lstat(join(root, 'file.txt'));
    expect(file).toMatchObject({ size: 5, type: 'file' });
    expect(file.mode & 0o170000).toBe(0o100000);
    expect(file.mtimeMs).toBeGreaterThan(0);
    expect(file.ctimeMs).toBeGreaterThan(0);
    expect(file.ino).toBeGreaterThan(0);
    expect((await host.lstat(join(root, 'dir'))).type).toBe('directory');
    expect((await host.lstat(join(root, 'link'))).type).toBe('symlink');
    expect((await host.stat(join(root, 'link'))).type).toBe('file');
    await expect(host.lstat(join(root, 'missing'))).rejects.toThrow();
  });

  test(`${name}: lstatMany preserves order and returns null for missing paths`, async () => {
    await using fixture = await createFixture();
    await createEntries(fixture);
    const { host, root } = fixture;
    const stats = await host.lstatMany([
      join(root, 'file.txt'),
      join(root, 'missing'),
      join(root, 'dir'),
    ]);
    expect(stats.map((stat) => stat?.type ?? null)).toEqual(['file', null, 'directory']);
    expect(await host.lstatMany([])).toEqual([]);
  });

  test(`${name}: readFile and readFiles return bytes and per-path errors`, async () => {
    await using fixture = await createFixture();
    const { host, root } = fixture;
    const bytes = Buffer.from([0, 255, 10, 128]);
    await host.writeFile(join(root, 'binary.bin'), bytes);
    expect((await host.readFile(join(root, 'binary.bin'))).equals(bytes)).toBe(true);
    const [present, missing] = await host.readFiles([
      join(root, 'binary.bin'),
      join(root, 'missing'),
    ]);
    expect(Buffer.isBuffer(present) && present.equals(bytes)).toBe(true);
    expect(missing).toBeInstanceOf(Error);
    await expect(host.readFile(join(root, 'missing'))).rejects.toThrow();
  });

  test(`${name}: readlink and realpath resolve symlinks`, async () => {
    await using fixture = await createFixture();
    await createEntries(fixture);
    const { host, root } = fixture;
    expect(await host.readlink(join(root, 'link'))).toBe('file.txt');
    expect(await host.realpath(join(root, 'link'))).toBe(
      await host.realpath(join(root, 'file.txt')),
    );
  });

  test(`${name}: exclusive writeFile applies the mode and refuses to overwrite`, async () => {
    await using fixture = await createFixture();
    const { host, root } = fixture;
    const path = join(root, 'script.sh');
    await host.writeFile(path, '#!/bin/sh\n', { exclusive: true, mode: 0o755 });
    expect((await host.stat(path)).mode & 0o777).toBe(0o755);
    await expect(host.writeFile(path, 'again', { exclusive: true, mode: 0o644 })).rejects.toThrow();
    expect((await host.readFile(path)).toString('utf8')).toBe('#!/bin/sh\n');
  });

  test(`${name}: rename, rm and mkdtemp manage files on the host`, async () => {
    await using fixture = await createFixture();
    const { host, root } = fixture;
    await host.writeFile(join(root, 'a.txt'), 'a');
    await host.rename(join(root, 'a.txt'), join(root, 'b.txt'));
    expect((await host.readFile(join(root, 'b.txt'))).toString('utf8')).toBe('a');
    await expect(host.lstat(join(root, 'a.txt'))).rejects.toThrow();

    const temporary = await host.mkdtemp('codiff-host-contract-');
    expect(basename(temporary).startsWith('codiff-host-contract-')).toBe(true);
    await host.writeFile(join(temporary, 'nested.txt'), 'x');
    expect((await host.lstat(temporary)).type).toBe('directory');
    await host.rm(temporary, { force: true, recursive: true });
    await expect(host.lstat(temporary)).rejects.toThrow();
    await host.rm(join(root, 'never-existed'), { force: true });
  });
};
```

- [ ] **Step 5: Write the `LocalHost` test**

Create `electron/__tests__/local-host.test.ts`:

```ts
import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { RepositoryHost } from '../host/repository-host.cjs';
import { defineRepositoryHostContract } from './helpers/repository-host-contract.ts';

const require = createRequire(import.meta.url);
const { createLocalHost } = require('../host/local-host.cjs') as {
  createLocalHost: () => RepositoryHost;
};

defineRepositoryHostContract('LocalHost', async () => {
  const directory = await createTemporaryDirectory('codiff-local-host-');
  return {
    host: createLocalHost(),
    root: directory.path,
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  };
});

test('LocalHost identifies itself as local', () => {
  const host = createLocalHost();
  expect(host.id).toBe('local');
  expect(host.label).toBe('');
});

test('LocalHost keeps the execFile error message for commands without input', async () => {
  // Git failure messages reach users (for example as commit failure reasons),
  // so they must stay byte-identical to the pre-host implementation.
  await expect(createLocalHost().exec('git', ['-C', '/', 'no-such-command'])).rejects.toThrow(
    /^Command failed: git -C \/ no-such-command/,
  );
});

test('LocalHost reads the process environment at call time', async () => {
  const host = createLocalHost();
  process.env.CODIFF_LOCAL_HOST_LATE = 'late';
  try {
    const output = await host.exec('/bin/sh', ['-c', 'printf %s "$CODIFF_LOCAL_HOST_LATE"']);
    expect(output.toString('utf8')).toBe('late');
  } finally {
    delete process.env.CODIFF_LOCAL_HOST_LATE;
  }
});
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `vp test electron/__tests__/local-host.test.ts`
Expected: FAIL with `Cannot find module '../host/local-host.cjs'`.

- [ ] **Step 7: Implement `LocalHost`**

Create `electron/host/local-host.cjs`:

```js
// @ts-check

const { execFile, spawn } = require('node:child_process');
const { promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnPty } = require('../pty.cjs');

/**
 * @typedef {import('./repository-host.cjs').HostStat} HostStat
 * @typedef {import('./repository-host.cjs').RepositoryHost} RepositoryHost
 */

const DEFAULT_MAX_BUFFER = 1024 * 1024 * 64;

/** @param {import('node:fs').Stats} stats @returns {HostStat} */
const toHostStat = (stats) => ({
  ctimeMs: stats.ctimeMs,
  ino: stats.ino,
  mode: stats.mode,
  mtimeMs: stats.mtimeMs,
  size: stats.size,
  type: stats.isSymbolicLink()
    ? 'symlink'
    : stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : 'other',
});

/** @param {unknown} error */
const toError = (error) => (error instanceof Error ? error : new Error(String(error)));

/** @param {Readonly<Record<string, string>> | undefined} env @returns {NodeJS.ProcessEnv} */
const mergeEnvironment = (env) => (env ? { ...process.env, ...env } : process.env);

/** @type {RepositoryHost['exec']} */
const exec = (command, args, options = {}) => {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const env = mergeEnvironment(options.env);
  if (options.input === undefined) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        [...args],
        { cwd: options.cwd, encoding: 'buffer', env, maxBuffer, signal: options.signal },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  }

  const input = options.input;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;

    /** @param {Error} error */
    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        child.kill();
        fail(new Error(`${command} output exceeded ${maxBuffer} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPIPE') {
        fail(error);
      }
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(
          new Error(
            Buffer.concat(stderr).toString('utf8') || `${command} exited with status ${code}`,
          ),
        );
      }
    });

    child.stdin.end(input);
  });
};

/** @type {RepositoryHost['writeFile']} */
const writeFile = async (path, contents, options = {}) => {
  if (!options.exclusive) {
    await fs.writeFile(path, contents, options.mode == null ? undefined : { mode: options.mode });
    return;
  }
  const file = await fs.open(path, 'wx', options.mode);
  try {
    if (options.mode != null) {
      await file.chmod(options.mode);
    }
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
};

/** @returns {RepositoryHost} */
const createLocalHost = () =>
  Object.freeze({
    exec,
    id: 'local',
    label: '',
    lstat: async (path) => toHostStat(await fs.lstat(path)),
    lstatMany: (paths) =>
      Promise.all(paths.map((path) => fs.lstat(path).then(toHostStat, () => null))),
    mkdtemp: (prefix) => fs.mkdtemp(join(tmpdir(), prefix)),
    readFile: (path) => fs.readFile(path),
    readFiles: (paths) => Promise.all(paths.map((path) => fs.readFile(path).catch(toError))),
    readlink: (path) => fs.readlink(path),
    realpath: (path) => fs.realpath(path),
    rename: (from, to) => fs.rename(from, to),
    rm: (path, options = {}) => fs.rm(path, options),
    spawn: (command, args, options = {}) =>
      spawn(command, [...args], {
        cwd: options.cwd,
        env: mergeEnvironment(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    spawnPty: (command, args, options) =>
      spawnPty(command, [...args], { ...options, env: mergeEnvironment(options.env) }),
    stat: async (path) => toHostStat(await fs.stat(path)),
    writeFile,
  });

module.exports = { createLocalHost };
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `vp test electron/__tests__/local-host.test.ts`
Expected: PASS (all contract tests plus the three local-only tests). Then run the type-check from Step 2; expected: no errors in `electron/host/`.

- [ ] **Step 9: Check, build and commit**

```bash
vp check --fix
vpr build
git add electron/host electron/__tests__/helpers/repository-host-contract.ts electron/__tests__/local-host.test.ts
git commit -m "Add a RepositoryHost interface with a local implementation."
```

---

### Task 2: Per-window repository registry

**Files:**

- Create: `electron/window-repositories.cjs`
- Create: `electron/__tests__/window-repositories.test.ts`

**Interfaces:**

- Consumes: `RepositoryHost` (Task 1).
- Produces: `createWindowRepositories({getLaunchPath, localHost})` returning `{delete(id: number): void; get(id: number): WindowRepository; set(id: number, repository: WindowRepository): void}` where `WindowRepository = {host: RepositoryHost; repositoryPath: string}`.

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/window-repositories.test.ts`:

```ts
import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../host/repository-host.cjs';

type WindowRepository = { host: RepositoryHost; repositoryPath: string };

const require = createRequire(import.meta.url);
const { createWindowRepositories } = require('../window-repositories.cjs') as {
  createWindowRepositories: (options: {
    getLaunchPath: () => string;
    localHost: RepositoryHost;
  }) => {
    delete: (id: number) => void;
    get: (id: number) => WindowRepository;
    set: (id: number, repository: WindowRepository) => void;
  };
};

const localHost = { id: 'local', label: '' } as RepositoryHost;
const otherHost = { id: 'other', label: 'other' } as RepositoryHost;

test('falls back to the local host and the current launch path', () => {
  let launchPath = '/first';
  const repositories = createWindowRepositories({ getLaunchPath: () => launchPath, localHost });
  expect(repositories.get(1)).toEqual({ host: localHost, repositoryPath: '/first' });
  launchPath = '/second';
  expect(repositories.get(1).repositoryPath).toBe('/second');
});

test('returns the stored host and path for a window until it is deleted', () => {
  const repositories = createWindowRepositories({ getLaunchPath: () => '/launch', localHost });
  repositories.set(7, { host: otherHost, repositoryPath: '/srv/app' });
  expect(repositories.get(7)).toEqual({ host: otherHost, repositoryPath: '/srv/app' });
  expect(repositories.get(8)).toEqual({ host: localHost, repositoryPath: '/launch' });
  repositories.delete(7);
  expect(repositories.get(7)).toEqual({ host: localHost, repositoryPath: '/launch' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test electron/__tests__/window-repositories.test.ts`
Expected: FAIL with `Cannot find module '../window-repositories.cjs'`.

- [ ] **Step 3: Implement the registry**

Create `electron/window-repositories.cjs`:

```js
// @ts-check

/**
 * @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {{host: RepositoryHost; repositoryPath: string}} WindowRepository
 */

/**
 * Tracks which repository, on which host, each window shows. Windows that have
 * not stored one yet use the local host and the current launch path.
 *
 * @param {{getLaunchPath: () => string; localHost: RepositoryHost}} options
 */
const createWindowRepositories = ({ getLaunchPath, localHost }) => {
  /** @type {Map<number, WindowRepository>} */
  const repositories = new Map();
  return {
    /** @param {number} id */
    delete: (id) => {
      repositories.delete(id);
    },
    /** @param {number} id @returns {WindowRepository} */
    get: (id) => repositories.get(id) ?? { host: localHost, repositoryPath: getLaunchPath() },
    /** @param {number} id @param {WindowRepository} repository */
    set: (id, repository) => {
      repositories.set(id, repository);
    },
  };
};

module.exports = { createWindowRepositories };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test electron/__tests__/window-repositories.test.ts`
Expected: PASS.

- [ ] **Step 5: Check, build and commit**

```bash
vp check --fix
vpr build
git add electron/window-repositories.cjs electron/__tests__/window-repositories.test.ts
git commit -m "Add a per-window repository registry."
```

---

### Task 3: Thread `host` through every Git call

This task changes the Git helpers' signatures and propagates `host` to every caller in one green step. It is mechanical; the type-check drives it.

**Files:**

- Modify: `electron/git-state/common.cjs:51-110` (helpers) and `:850` (`gitOrEmpty`)
- Modify: `electron/git-state/commit.cjs`, `commit-metadata.cjs`, `comparison.cjs`, `git-files.cjs`, `working-tree.cjs`, `pull-request.cjs`, `merge-request.cjs`
- Modify: `electron/git-state.cjs`
- Modify: `electron/generated-files.cjs` (calls only; temp directory handling changes in Task 6)
- Modify: `electron/repository-watcher.cjs` (calls and coordinator; file reads change in Tasks 4 and 5)
- Modify: `electron/definition-search.cjs` (calls only; spawn changes in Task 6)
- Modify: `electron/walkthrough-commit.cjs` (calls only; PTY and message file change in Task 7)
- Modify: `electron/main.cjs`
- Test: `core/__tests__/git-state.test.ts`, `core/__tests__/git-files.test.ts`, `core/__tests__/gitlab.test.ts`, `core/__tests__/git-state.bench.ts`, `electron/__tests__/repository-watcher.test.ts`, `electron/__tests__/definition-search.test.ts`, `electron/__tests__/walkthrough-commit.test.ts`, `electron/__tests__/git-identity.test.ts`, `electron/__tests__/pull-request-command.test.ts`, `electron/__tests__/pull-request-remote.test.ts`, `electron/__tests__/pull-request-review.test.ts`, `electron/__tests__/narrative-walkthrough.test.ts` (only where it calls changed functions)

**Interfaces:**

- Consumes: `RepositoryHost`, `createLocalHost` (Task 1); `createWindowRepositories` (Task 2).
- Produces (later tasks rely on these exact signatures):
  - `git(host, repoPath, args, options?) => Promise<string>`
  - `gitBuffer(host, repoPath, args) => Promise<Buffer>`
  - `gitBufferWithInput(host, repoPath, args, input, options?: {env?: Readonly<Record<string, string>>}) => Promise<Buffer>`
  - `gitOrEmpty(host, repoRoot, args) => Promise<string>` (both copies, in `common.cjs` and `working-tree.cjs`)
  - Every exported function of `electron/git-state.cjs` takes `host` first, e.g. `readRepositoryState(host, launchPath, source?, options?)`, `readWalkthroughRepositoryState(host, launchPath, source?, options?)`, `listRepositoryHistory(host, launchPath, limit?, source?)`, `readDiffSectionContent(host, launchPath, request)`, `readDiffImageContent(host, launchPath, request)`, `readGitIdentity(host, launchPath)`, `readRepositoryChangeSignature(host, launchPath, exactPaths?)`, `readWorkingTreeState(host, launchPath, options?)`, `readCommitState(host, launchPath, ref)`, `readBranchState(host, launchPath, input)`, `readPullRequestState(host, launchPath, source)`, `resolvePullRequestContentRefs(host, repoRoot, pullRequest, metadata, selectedRemote?)`, `submitPullRequestComment(host, launchPath, request)`, `submitPullRequestReview(host, launchPath, request)`.
  - `readGeneratedAttributeStates(host, repoRoot, paths, source)`, `annotateGeneratedFiles(host, state)`
  - `readRepositoryWatcherSnapshot(host, repoRoot, exactPaths?, knownDirtyPaths?)`; coordinator `readSnapshot(host, root, exactPaths, knownDirtyPaths)`; subscriber objects passed to `attach` gain `host`; `reset(id, host, root)`.
  - `findDefinitions(host, repoPath, request, options?)`, `runBoundedGitGrep(host, repoPath, args, options?)`, coordinator `find(key, host, repoPath, request)`.
  - `createWalkthroughCommit(host, repoPath, request, onOutput?)`.
  - Functions whose only repository use is `cwd` for `gh` or `glab` (`runGhApi`, `ghApi`, `ghApiBuffer`, `glabApi` and the `readPullRequest*`/`readMergeRequest*` API readers that only call them) do **not** take `host`; PR/MR review stays local-only.

- [ ] **Step 1: Update the tests to pass a host**

In every test file listed above:

1. Add near the other `require` calls:

   ```ts
   const { createLocalHost } = require('../../electron/host/local-host.cjs') as {
     createLocalHost: () => import('../../electron/host/repository-host.cjs').RepositoryHost;
   };
   const host = createLocalHost();
   ```

   (For files in `electron/__tests__`, the paths are `../host/local-host.cjs` and `../host/repository-host.cjs`.)

2. Prefix calls of changed functions with `host`. For `core/__tests__/git-state.test.ts`:

   ```bash
   perl -pi -e 's/\b(readRepositoryState|readWorkingTreeState|readWalkthroughRepositoryState|readDiffSectionContent|readDiffImageContent|listRepositoryHistory|readRepositoryChangeSignature|readGeneratedAttributeStates|resolvePullRequestContentRefs|readCommitState|readBranchState|readPullRequestState|readGitIdentity)\((?!host\b)/$1(host, /g' core/__tests__/git-state.test.ts
   ```

   Run the same command, adjusting the function list to the names each file actually calls, for `git-files.test.ts` (`readGitFiles`, `readTreeEntries`, `readObjectSizes`, `readObjectContents`), `gitlab.test.ts` (`readMergeRequestState`, `listMergeRequestHistory`, `readMergeRequestImageContent`, `submitMergeRequestComment`, `submitMergeRequestReview`), `git-state.bench.ts`, `repository-watcher.test.ts` (`readRepositoryWatcherSnapshot`, `readRepositoryChangeSignature`), `definition-search.test.ts` (`findDefinitions`), `walkthrough-commit.test.ts` (`createWalkthroughCommit`), `git-identity.test.ts` (`readGitIdentity`) and the `pull-request-*.test.ts` files (`readPullRequestState`, `listPullRequestHistory`, `resolvePullRequestContentRefs`, `selectPullRequestRemote`, `submitPullRequestComment`, `submitPullRequestReview`). The pattern only matches calls (`name(`), not type members (`name: (`).

3. In each file's hand-written module type (for example `GitStateModule`), add `host: RepositoryHost` as the first parameter of every function you just prefixed. Example:

   ```ts
   readRepositoryState: (
     host: RepositoryHost,
     launchPath: string,
     source?: ReviewSource,
     options?: { showWhitespace?: boolean },
   ) => Promise<RepositoryState>;
   ```

4. In `repository-watcher.test.ts`, coordinator tests pass a fake `readSnapshot`; change those fakes to accept `(host, root, exactPaths, knownDirtyPaths)` and pass `host` in every `attach({...})` subscriber and every `reset(id, host, root)` call.

5. Leave `runBoundedGitGrep` tests in `definition-search.test.ts` for Task 6.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test core/__tests__/git-state.test.ts`
Expected: FAIL. Calls now pass the host object where a path string is expected, so Git reports errors such as `fatal: cannot change to '[object Object]'`.

- [ ] **Step 3: Change the Git helpers in `common.cjs`**

Replace lines 51-110 of `electron/git-state/common.cjs` (the `git`, `gitBuffer` and `gitBufferWithInput` definitions) with:

```js
const GIT_MAX_BUFFER = 1024 * 1024 * 64;

/**
 * @param {RepositoryHost} host
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{encoding?: BufferEncoding}} [options]
 * @returns {Promise<string>}
 */
const git = async (host, repoPath, args, options = {}) =>
  (await host.exec('git', ['-C', repoPath, ...args], { maxBuffer: GIT_MAX_BUFFER })).toString(
    options.encoding || 'utf8',
  );

/** @param {RepositoryHost} host @param {string} repoPath @param {ReadonlyArray<string>} args @returns {Promise<Buffer>} */
const gitBuffer = (host, repoPath, args) =>
  host.exec('git', ['-C', repoPath, ...args], { maxBuffer: GIT_MAX_BUFFER });

/**
 * @param {RepositoryHost} host
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {string | Buffer} input
 * @param {{env?: Readonly<Record<string, string>>}} [options]
 * @returns {Promise<Buffer>}
 */
const gitBufferWithInput = (host, repoPath, args, input, options = {}) =>
  host.exec('git', ['-C', repoPath, ...args], { env: options.env, input });
```

Add `@typedef {import('../host/repository-host.cjs').RepositoryHost} RepositoryHost` to the typedef block at the top of the file. Remove the now-unused `execFile`, `spawn`, `promisify` and `execFileAsync` (keep the `fs` import until Task 4). Change `gitOrEmpty` (line ~850) and the copy in `working-tree.cjs` (line ~380) to `async (host, repoRoot, args)` calling `git(host, repoRoot, args)`.

- [ ] **Step 4: Propagate `host` until the type-check is clean**

Run the type-check. Repeat until it reports no errors:

- **`Cannot find name 'host'`** inside a function: add `host` as that function's first parameter and `@param {RepositoryHost} host` as the first JSDoc `@param` (add the `RepositoryHost` typedef import to that file if missing).
- **Argument count or type errors at a call site:** pass `host` as the first argument.

Before and after for a typical function in `electron/git-state/commit.cjs`:

```js
/** @param {string} repoRoot @param {string} commit */
const readCommitParents = async (repoRoot, commit) => {
  const raw = await git(repoRoot, ['rev-list', '--parents', '-n', '1', commit]);
```

```js
/** @param {RepositoryHost} host @param {string} repoRoot @param {string} commit */
const readCommitParents = async (host, repoRoot, commit) => {
  const raw = await git(host, repoRoot, ['rev-list', '--parents', '-n', '1', commit]);
```

Functions you should expect to change (cross-check when the type-check is clean):

- `commit-metadata.cjs`: `readCommitNumstat`, `readCommitMessageParts`, `readCommitMetadataForCommit`.
- `commit.cjs`: `readCommitParents`, `readCommitNameStatus`, `resolveRangeEndpoint`, `resolveRangeRefs`, `getBranchSuggestion`, `resolveBranchComparison`, `resolveComparisonSource`, `readResolvedComparison`, `readResolvedCommitComparison`, `readResolvedComparisonState`, `readComparisonSourceState`, `readComparisonSourceImageContent`, `readCommitStateFromComparison`, `readCommitState`, `readResolvedCommitState`, `readCommitSectionContent`, `readCommitImageContent`, `readRangeState`, `readRangeSectionContent`, `readRangeImageContent`, `readBranchState`, `readBranchSectionContent`, `readBranchImageContent`, `readBranchWorkingTreeState`, `readBranchWorkingTreeSectionContent`, `readBranchWorkingTreeImageContent`, `listRepositoryHistory`.
- `common.cjs`: `getBlobSize`, `readImageSpec`, `readGitImageFile`, `readIndexImageFile`, `readWorkingTreeImageFile`, `readGitFile`, `readIndexFile`, `readWorkingTreeFile`, `readFileStat`, `getPatch`, `getWorkingTreeContents`, `createSection`, `gitOrEmpty`.
- `comparison.cjs`: `readComparisonPatch`, `readComparisonPatches`, `readComparisonFiles`.
- `git-files.cjs`: `readTreeEntries`, `readObjectSizes`, `readObjectContents`, `readGitFiles`.
- `working-tree.cjs`: `readPatchMap`, `listUntrackedItems`, `readWorkingTreeState`, `getStatusItemForPath`, `readDiffSectionContent`, `readDiffImageContent`, `gitOrEmpty`, `readGitIdentity`.
- `pull-request.cjs`: `readLocalGitRemotes`, `remoteHasPullRequestHead`, `selectPullRequestRemote`, `fetchPullRequestHistoryRefs`, `readRepositoryCommits`, `listPullRequestHistory`, `resolvePullRequestContentRefs`, `readPullRequestState`, `readPullRequestImageContent`, `submitPullRequestComment`, `submitPullRequestReview`, and any helper the type-check flags.
- `merge-request.cjs`: `fetchMergeRequestRefs`, `resolveMergeRequestContentRefs`, `readMergeRequestState`, `readRepositoryCommits`, `listMergeRequestHistory`, `submitMergeRequestComment`, `submitMergeRequestReview`, `readMergeRequestImageContent`, and any helper the type-check flags.
- `git-state.cjs`: every function, including the `submitPullRequestComment`/`submitPullRequestReview` wrappers in `module.exports` (they become `(host, launchPath, request) => ...`).
- `generated-files.cjs`: `checkGeneratedAttributeStates`, `readGeneratedAttributeStatesFromTree`, `readGeneratedAttributeStates`, `annotateGeneratedFiles`. In `readGeneratedAttributeStatesFromTree`, change `env` to `{ GIT_INDEX_FILE: join(temporaryDirectory, 'index') }` (no `...process.env`); hosts merge `env` over their own environment.
- `repository-watcher.cjs`: `readRepositoryWatcherPathState`, `readRepositoryWatcherSnapshot`, `readRepositoryChangeSignature`.
- `definition-search.cjs`: `resolveSearchRevision` (make `host` its first parameter, before `request`), `findDefinitions`, `runBoundedGitGrep` (add the parameter now; it keeps using `spawnProcess` until Task 6), the coordinator's `find`.
- `walkthrough-commit.cjs`: `gitStreaming`, `createWalkthroughCommit`.

- [ ] **Step 5: Key the watcher coordinator by host and root**

In `createRepositoryWatcherCoordinator` (`electron/repository-watcher.cjs:223`):

1. Add a key helper above it:

   ```js
   /** @param {RepositoryHost} host @param {string} root */
   const getRepositoryWatcherKey = (host, root) => `${host.id}\0${root}`;
   ```

2. Add `host: RepositoryHost;` and `key: string;` to the `RepositoryWatcher` typedef.
3. `watchers` and `subscriberRoots` store and look up by `key` instead of `root`: replace every `watchers.get(watcher.root)`, `watchers.get(subscriber.root)`, `watchers.set(subscriber.root, …)`, `watchers.delete(root)` and `watchers.get(token.root)` with the corresponding `key`; `subscriberRoots.set(subscriber.id, key)`.
4. In `attach(subscriber)`, compute `const key = getRepositoryWatcherKey(subscriber.host, subscriber.root)` and create new watchers with `{ host: subscriber.host, key, root: subscriber.root, ... }`.
5. Self-write tokens returned by `beginWrite` gain `key: watcher.key`; `finishWrite` looks up by `token.key`.
6. `reset(id, host, root)` compares `subscriberRoots.get(id)` with `getRepositoryWatcherKey(host, root)`.
7. In `check`, call `readSnapshot(watcher.host, watcher.root, …)`.

`notify(root)` stays unchanged.

- [ ] **Step 6: Wire `main.cjs`**

1. Near the top-level `require` block, add:

   ```js
   const { createLocalHost } = require('./host/local-host.cjs');
   const { createWindowRepositories } = require('./window-repositories.cjs');
   ```

2. Replace `const windowRepositories = new Map();` (line 139) with:

   ```js
   const localHost = createLocalHost();
   const windowRepositories = createWindowRepositories({ getLaunchPath, localHost });
   ```

3. Replace `getWindowRepositoryRoot` (line 239) with:

   ```js
   /** @param {number} webContentsId @returns {import('./window-repositories.cjs').WindowRepository} */
   const getWindowRepository = (webContentsId) => {
     const repository = windowRepositories.get(webContentsId);
     const identityRoot = windowIdentities.get(webContentsId)?.repositoryRoot;
     return identityRoot ? { ...repository, repositoryPath: identityRoot } : repository;
   };
   ```

   `getMarkdownDocumentContext` uses `getWindowRepository(webContentsId).repositoryPath`.

4. Replace every `const repositoryPath = windowRepositories.get(X) || getLaunchPath();` (12 sites) with `const { host, repositoryPath } = windowRepositories.get(X);` and pass `host` first to the git-state, watcher, definition-search and walkthrough-commit call that follows. Replace every `getWindowRepositoryRoot(X)` call with `getWindowRepository(X)` and destructure `{ host, repositoryPath }`. For calls into modules not threaded in this phase (agent runners, `review-assist`, markdown documents), keep passing only `repositoryPath`.
5. Replace `windowRepositories.set(id, path)` calls with `windowRepositories.set(id, { host: localHost, repositoryPath: path })`. In `storeResolvedRepositoryState`, keep the window's current host: `windowRepositories.set(webContentsId, { host: windowRepositories.get(webContentsId).host, repositoryPath: state.root })`.
6. `readRepositoryStateWithConfig`, `readInitialRepositoryStateWithConfig`, `readSafeRepositoryWatcherSnapshot`, `resetRepositoryWatcher`, `startRepositoryWatcher` and `createWindow` take `host` first and pass it through. `focusOrCreateWindow` passes `localHost` to `createWindow` (Task 9 makes the host a parameter). `startRepositoryWatcher` passes `host` in the `attach({...})` subscriber.
7. In the `definitionSearchCoordinator.find(...)` handler, pass `(event.sender.id, host, repositoryPath, request)`.

- [ ] **Step 7: Verify no Git call still passes a path first**

Run:

```bash
grep -rnE "\b(git|gitBuffer|gitBufferWithInput|gitOrEmpty)\((repoRoot|repoPath|launchPath|repositoryPath|repositoryRoot|root|state\.root)\b" electron
```

Expected: no output.

- [ ] **Step 8: Run the type-check and the full test suite**

Run the type-check, then `vp test`.
Expected: no type errors; all tests pass, including Task 1 and Task 2 tests.

- [ ] **Step 9: Smoke-test the app**

Run `vpr build`, launch Codiff on this repository with a modified file, an untracked file and an image change (for example `node ./bin/codiff.js`), and confirm: the diff loads, history loads, editing a file and saving works, Mod-click definition search works, and the diff refreshes after editing a file in another editor.

- [ ] **Step 10: Check and commit**

```bash
vp check --fix
vpr build
git add -A electron core/__tests__
git commit -m "Pass a RepositoryHost to every Git operation."
```

---

### Task 4: Read working-tree files through the host

**Files:**

- Create: `core/__tests__/helpers/recording-host.ts`
- Modify: `electron/git-state/common.cjs` (`readFileStat`, `readWorkingTreeImageFile`, `readWorkingTreeFile`)
- Modify: `electron/git-state/working-tree.cjs` (`getStatusItemForPath`, around line 305)
- Modify: `electron/repository-watcher.cjs` (`readRepositoryWatcherPathState`)
- Test: `core/__tests__/git-state.test.ts`, `electron/__tests__/repository-watcher.test.ts`

**Interfaces:**

- Consumes: Task 3 signatures; `HostStat`.
- Produces:
  - `readFileStat(host, repoRoot, path): Promise<HostStat | undefined>` (callers test `stat.type === 'file'` etc. instead of `stat.isFile()`).
  - `createRecordingHost(inner: RepositoryHost): { calls: Array<{ args: ReadonlyArray<unknown>; method: string }>; host: RepositoryHost }` in `core/__tests__/helpers/recording-host.ts`.

- [ ] **Step 1: Write the recording host helper**

Create `core/__tests__/helpers/recording-host.ts`:

```ts
import type { RepositoryHost } from '../../../electron/host/repository-host.cjs';

export type HostCall = { args: ReadonlyArray<unknown>; method: string };

export const createRecordingHost = (inner: RepositoryHost) => {
  const calls: Array<HostCall> = [];
  const host = Object.fromEntries(
    Object.entries(inner).map(([method, value]) => [
      method,
      typeof value === 'function'
        ? (...args: Array<unknown>) => {
            calls.push({ args, method });
            return (value as (...values: Array<unknown>) => unknown)(...args);
          }
        : value,
    ]),
  ) as RepositoryHost;
  return { calls, host };
};
```

- [ ] **Step 2: Write the failing tests**

Add to `core/__tests__/git-state.test.ts` (use the file's existing repo-setup helpers `git`, `writeRepoFile`, `commitAll`, `withGitTestEnvironment`, `createTemporaryDirectory`):

```ts
import { createRecordingHost } from './helpers/recording-host.ts';

test('readWorkingTreeState reads working-tree files only through the host', async () => {
  await withGitTestEnvironment(async () => {
    await using directory = await createTemporaryDirectory('codiff-host-reads-');
    const repo = await realpath(directory.path);
    await git(repo, ['init']);
    await writeRepoFile(repo, 'tracked.txt', 'one\n');
    await commitAll(repo, 'Initial commit.');
    await writeRepoFile(repo, 'tracked.txt', 'two\n');
    await writeRepoFile(repo, 'untracked.txt', 'new\n');

    const { calls, host: recordingHost } = createRecordingHost(host);
    const state = await readWorkingTreeState(recordingHost, repo);

    expect(state.files.map((file) => file.path)).toEqual(['tracked.txt', 'untracked.txt']);
    const readPaths = calls
      .filter(({ method }) => ['lstat', 'lstatMany', 'readFile', 'readFiles'].includes(method))
      .flatMap(({ args }) => (Array.isArray(args[0]) ? args[0] : [args[0]]));
    expect(readPaths).toContain(join(repo, 'untracked.txt'));
    expect(readPaths).toContain(join(repo, 'tracked.txt'));
  });
});
```

Add to `electron/__tests__/repository-watcher.test.ts` a shared fixture and the test (import `createTemporaryDirectory` from `../../core/__tests__/helpers/resources.ts` and `createRecordingHost` from `../../core/__tests__/helpers/recording-host.ts` if not already imported; the file's `git` helper already sets author and committer):

```ts
const createDirtyRepository = async (directory: { path: string }, paths: ReadonlyArray<string>) => {
  const repo = await realpath(directory.path);
  await git(repo, ['init']);
  for (const path of paths) {
    await writeFile(join(repo, path), 'one\n');
  }
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Initial commit.']);
  for (const path of paths) {
    await writeFile(join(repo, path), 'two\n');
  }
  return repo;
};

test('readRepositoryWatcherSnapshot stats dirty paths through the host', async () => {
  await using directory = await createTemporaryDirectory('codiff-watcher-host-');
  const repo = await createDirtyRepository(directory, ['a.txt']);
  const { calls, host: recordingHost } = createRecordingHost(host);
  await readRepositoryWatcherSnapshot(recordingHost, repo, ['a.txt']);
  const statted = calls
    .filter(({ method }) => method === 'lstat' || method === 'lstatMany')
    .flatMap(({ args }) => (Array.isArray(args[0]) ? args[0] : [args[0]]));
  expect(statted).toContain(join(repo, 'a.txt'));
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `vp test core/__tests__/git-state.test.ts -t "only through the host"` and `vp test electron/__tests__/repository-watcher.test.ts -t "through the host"`
Expected: FAIL; `readPaths`/`statted` are empty because the code still calls `fs` directly.

- [ ] **Step 4: Route `common.cjs` file reads through the host**

```js
/** @param {RepositoryHost} host @param {string} repoRoot @param {string} path @returns {Promise<HostStat | undefined>} */
const readFileStat = async (host, repoRoot, path) => {
  try {
    return await host.lstat(join(repoRoot, path));
  } catch {
    return undefined;
  }
};
```

Add `@typedef {import('../host/repository-host.cjs').HostStat} HostStat` to the typedef block. In `readWorkingTreeImageFile` replace `!stat.isFile()` with `stat.type !== 'file'` and `fs.readFile(join(repoRoot, path))` with `host.readFile(join(repoRoot, path))`. In `readWorkingTreeFile` replace `stat.isDirectory()` → `stat.type === 'directory'`, `stat.isSymbolicLink()` → `stat.type === 'symlink'`, `!stat.isFile()` → `stat.type !== 'file'`, `fs.readlink(...)` → `host.readlink(...)`, `fs.readFile(...)` → `host.readFile(...)`. Remove the `fs` import from `common.cjs`. In `working-tree.cjs` `getStatusItemForPath`, apply the same `stat.type` replacements to its use of `readFileStat`.

- [ ] **Step 5: Route watcher path state through the host**

Replace `readRepositoryWatcherPathState` in `electron/repository-watcher.cjs`:

```js
/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} path
 * @param {boolean} exact
 */
const readRepositoryWatcherPathState = async (host, repoRoot, path, exact) => {
  try {
    const absolutePath = join(repoRoot, path);
    const stat = await host.lstat(absolutePath);
    const metadata = `${path}\0${stat.type}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
    if (!exact) {
      return { metadata };
    }

    const version =
      stat.type === 'symlink'
        ? getFingerprint(await host.readlink(absolutePath))
        : stat.type === 'file'
          ? getFingerprint(await host.readFile(absolutePath))
          : undefined;
    return { metadata, version };
  } catch {
    return { metadata: `${path}\0missing` };
  }
};
```

`stat.type` yields exactly the strings the old code built (`directory`, `symlink`, `file`, `other`), so signatures are unchanged. Remove the `fs` import from `repository-watcher.cjs`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `vp test core/__tests__/git-state.test.ts electron/__tests__/repository-watcher.test.ts`
Expected: PASS, including all pre-existing tests. Run the type-check; expected clean.

- [ ] **Step 7: Check, build and commit**

```bash
vp check --fix
vpr build
git add core/__tests__/helpers/recording-host.ts core/__tests__/git-state.test.ts electron/git-state electron/repository-watcher.cjs electron/__tests__/repository-watcher.test.ts
git commit -m "Read working-tree files through the repository host."
```

---

### Task 5: Batch untracked-file and watcher reads

**Files:**

- Modify: `electron/git-state/common.cjs` (add `prefetchWorkingTreeFiles`; `readWorkingTreeFile`, `getWorkingTreeContents` and `createSection` accept a prefetched entry)
- Modify: `electron/git-state/working-tree.cjs` (`readWorkingTreeState`)
- Modify: `electron/repository-watcher.cjs` (`readRepositoryWatcherSnapshot`)
- Test: `core/__tests__/git-state.test.ts`, `electron/__tests__/repository-watcher.test.ts`

**Interfaces:**

- Consumes: Task 4's `readFileStat` and recording host.
- Produces:
  - `prefetchWorkingTreeFiles(host, repoRoot, paths: ReadonlyArray<string>): Promise<Map<string, PrefetchedWorkingTreeFile>>` where `PrefetchedWorkingTreeFile = {contents?: Buffer; stat: HostStat | undefined}`.
  - `ReadFileOptions` gains `prefetched?: PrefetchedWorkingTreeFile`.

- [ ] **Step 1: Write the failing tests**

Add to `core/__tests__/git-state.test.ts`:

```ts
test('readWorkingTreeState batches untracked file reads and skips oversized files and symlinks', async () => {
  await withGitTestEnvironment(async () => {
    await using directory = await createTemporaryDirectory('codiff-host-batch-');
    const repo = await realpath(directory.path);
    await git(repo, ['init']);
    await writeRepoFile(repo, 'committed.txt', 'base\n');
    await commitAll(repo, 'Initial commit.');
    await writeRepoFile(repo, 'a.txt', 'alpha\n');
    await writeRepoFile(repo, 'b.txt', 'beta\n');
    await writeRepoFile(repo, 'large.bin', Buffer.alloc(3 * 1024 * 1024, 1));
    await symlink('/etc/hosts', join(repo, 'outside-link'));

    const { calls, host: recordingHost } = createRecordingHost(host);
    const state = await readWorkingTreeState(recordingHost, repo);

    expect(calls.filter(({ method }) => method === 'lstatMany')).toHaveLength(1);
    const readFilesCalls = calls.filter(({ method }) => method === 'readFiles');
    expect(readFilesCalls).toHaveLength(1);
    expect(readFilesCalls[0].args[0]).toEqual([join(repo, 'a.txt'), join(repo, 'b.txt')]);
    expect(calls.filter(({ method }) => method === 'lstat' || method === 'readFile')).toHaveLength(
      0,
    );
    expect(
      calls.some(
        ({ args, method }) => method === 'readlink' && args[0] === join(repo, 'outside-link'),
      ),
    ).toBe(true);

    const byPath = new Map(state.files.map((file) => [file.path, file]));
    expect(byPath.get('a.txt')?.sections[0].newFile?.contents).toBe('alpha\n');
    expect(byPath.get('outside-link')?.sections[0].newFile?.contents).toBe('/etc/hosts');
    expect(byPath.get('large.bin')?.sections[0].newFile).toBeUndefined();
  });
});
```

Add to `electron/__tests__/repository-watcher.test.ts` (uses `createDirtyRepository` from Task 4):

```ts
test('readRepositoryWatcherSnapshot uses one batched stat for all dirty paths', async () => {
  await using directory = await createTemporaryDirectory('codiff-watcher-batch-');
  const repo = await createDirtyRepository(directory, ['a.txt', 'b.txt', 'c.txt']);
  const { calls, host: recordingHost } = createRecordingHost(host);
  const batched = await readRepositoryWatcherSnapshot(recordingHost, repo, ['a.txt']);
  expect(calls.filter(({ method }) => method === 'lstatMany')).toHaveLength(1);
  expect(calls.filter(({ method }) => method === 'lstat')).toHaveLength(0);
  expect(Object.keys(batched.pathSignatures)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  expect(batched.pathVersions?.['a.txt']).toBeDefined();
  expect(batched).toEqual(await readRepositoryWatcherSnapshot(host, repo, ['a.txt']));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test core/__tests__/git-state.test.ts -t "batches untracked"` and `vp test electron/__tests__/repository-watcher.test.ts -t "batched stat"`
Expected: FAIL; `lstatMany` count is 0 and per-file `lstat` calls are present.

- [ ] **Step 3: Implement prefetching in `common.cjs`**

Add after `readFileStat`:

```js
/**
 * @typedef {{contents?: Buffer; stat: HostStat | undefined}} PrefetchedWorkingTreeFile
 */

/**
 * Stat many working-tree paths in one host round trip, then read every regular
 * file that fits the eager text limit in a second one. Symlinks and oversized
 * files keep their stat but are not read, matching `readWorkingTreeFile`.
 *
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} paths
 * @returns {Promise<Map<string, PrefetchedWorkingTreeFile>>}
 */
const prefetchWorkingTreeFiles = async (host, repoRoot, paths) => {
  /** @type {Map<string, PrefetchedWorkingTreeFile>} */
  const prefetched = new Map();
  if (paths.length === 0) {
    return prefetched;
  }
  const stats = await host.lstatMany(paths.map((path) => join(repoRoot, path)));
  /** @type {Array<string>} */
  const readablePaths = [];
  paths.forEach((path, index) => {
    const stat = stats[index] ?? undefined;
    prefetched.set(path, { stat });
    if (stat?.type === 'file' && stat.size <= EAGER_TEXT_FILE_LIMIT) {
      readablePaths.push(path);
    }
  });
  if (readablePaths.length > 0) {
    const contents = await host.readFiles(readablePaths.map((path) => join(repoRoot, path)));
    readablePaths.forEach((path, index) => {
      const value = contents[index];
      if (Buffer.isBuffer(value)) {
        prefetched.set(path, { contents: value, stat: prefetched.get(path)?.stat });
      }
    });
  }
  return prefetched;
};
```

Add `prefetched?: PrefetchedWorkingTreeFile` to the `ReadFileOptions` typedef. In `readWorkingTreeFile`:

- Replace `const stat = await readFileStat(host, repoRoot, path);` with `const stat = options.prefetched ? options.prefetched.stat : await readFileStat(host, repoRoot, path);`.
- Replace the final `const buffer = await host.readFile(join(repoRoot, path));` with `const buffer = options.prefetched?.contents ?? (await host.readFile(join(repoRoot, path)));`.

`getWorkingTreeContents` already passes `options` to `readWorkingTreeFile` for untracked items; make sure `createSection` forwards `options.prefetched` unchanged to `getWorkingTreeContents`. Export `prefetchWorkingTreeFiles`.

- [ ] **Step 4: Prefetch untracked files in `readWorkingTreeState`**

In `electron/git-state/working-tree.cjs`, after `const status = …sort(fileSort);`:

```js
const prefetchedFiles = await prefetchWorkingTreeFiles(
  host,
  repoRoot,
  status
    .filter((item) => item.untracked && !item.directory && !item.summary)
    .map((item) => item.path),
);
```

In the `item.unstaged` branch, pass `prefetched: item.untracked ? prefetchedFiles.get(item.path) : undefined` in the `createSection` options. Import `prefetchWorkingTreeFiles` from `./common.cjs`.

- [ ] **Step 5: Batch the watcher**

In `readRepositoryWatcherSnapshot`, replace the `Promise.all([...paths].map(… readRepositoryWatcherPathState …))` block with:

```js
const pathList = [...paths];
const stats = await host.lstatMany(pathList.map((path) => join(repoRoot, path)));
const exactFilePaths = pathList.filter(
  (path, index) => normalizedExactPaths.has(path) && stats[index]?.type === 'file',
);
const exactFileContents = await host.readFiles(exactFilePaths.map((path) => join(repoRoot, path)));
/** @type {Map<string, Buffer | Error>} */
const exactFiles = new Map(exactFilePaths.map((path, index) => [path, exactFileContents[index]]));
const states = await Promise.all(
  pathList.map(async (path, index) => [
    path,
    await describeRepositoryWatcherPath(host, repoRoot, path, stats[index], {
      contents: exactFiles.get(path),
      exact: normalizedExactPaths.has(path),
    }),
  ]),
);
```

Replace `readRepositoryWatcherPathState` with:

```js
/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} path
 * @param {HostStat | null} stat
 * @param {{contents?: Buffer | Error; exact: boolean}} options
 */
const describeRepositoryWatcherPath = async (host, repoRoot, path, stat, options) => {
  if (!stat) {
    return { metadata: `${path}\0missing` };
  }
  const metadata = `${path}\0${stat.type}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.ino}`;
  if (!options.exact) {
    return { metadata };
  }
  // The previous per-path implementation reported a path as missing when its
  // exact read failed after a successful lstat; keep that signature.
  if (stat.type === 'file' && !Buffer.isBuffer(options.contents)) {
    return { metadata: `${path}\0missing` };
  }
  try {
    const version =
      stat.type === 'symlink'
        ? getFingerprint(await host.readlink(join(repoRoot, path)))
        : stat.type === 'file' && Buffer.isBuffer(options.contents)
          ? getFingerprint(options.contents)
          : undefined;
    return { metadata, version };
  } catch {
    return { metadata: `${path}\0missing` };
  }
};
```

Add `@typedef {import('./host/repository-host.cjs').HostStat} HostStat` to the file's typedefs.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `vp test core/__tests__/git-state.test.ts electron/__tests__/repository-watcher.test.ts`
Expected: PASS, including every pre-existing watcher test (signatures unchanged). Run the type-check; expected clean.

- [ ] **Step 7: Check, build and commit**

```bash
vp check --fix
vpr build
git add electron/git-state electron/repository-watcher.cjs core/__tests__/git-state.test.ts electron/__tests__/repository-watcher.test.ts
git commit -m "Batch untracked file and watcher reads through the repository host."
```

---

### Task 6: Run `git grep` and temporary indexes on the host

**Files:**

- Modify: `electron/definition-search.cjs` (`runBoundedGitGrep`)
- Modify: `electron/generated-files.cjs` (`readGeneratedAttributeStatesFromTree`)
- Test: `electron/__tests__/definition-search.test.ts`, `core/__tests__/git-state.test.ts`

**Interfaces:**

- Consumes: Task 3 signatures; `host.spawn`, `host.mkdtemp`, `host.rm`.
- Produces: `runBoundedGitGrep(host, repoPath, args, options?: {maxMatches?; maxOutputBytes?; signal?; timeoutMs?})` (the `spawnProcess` option is removed).

- [ ] **Step 1: Update the grep tests to use a fake host**

In `electron/__tests__/definition-search.test.ts`, remove `spawnProcess` from the `runBoundedGitGrep` type and add a fake host helper next to `createFakeGitProcess`:

```ts
const createFakeHost = (child: ReturnType<typeof createFakeGitProcess>) => {
  const spawned: Array<{ args: ReadonlyArray<string>; command: string }> = [];
  const fakeHost = {
    id: 'fake',
    label: 'fake',
    spawn: (command: string, args: ReadonlyArray<string>) => {
      spawned.push({ args, command });
      return child;
    },
  } as unknown as RepositoryHost;
  return { fakeHost, spawned };
};
```

`createFakeGitProcess` must also provide a writable `stdin` (add `stdin: new PassThrough()` to its `Object.assign`). Change each of the three bounded-grep tests from

```ts
const output = runBoundedGitGrep('/repo', ['grep'], {
  maxMatches: 2,
  maxOutputBytes: 1024,
  spawnProcess: (() => child) as unknown as typeof import('node:child_process').spawn,
  timeoutMs: 1000,
});
```

to

```ts
const { fakeHost, spawned } = createFakeHost(child);
const output = runBoundedGitGrep(fakeHost, '/repo', ['grep'], {
  maxMatches: 2,
  maxOutputBytes: 1024,
  timeoutMs: 1000,
});
```

and add to the first one: `expect(spawned).toEqual([{ args: ['-C', '/repo', 'grep'], command: 'git' }]);`.

- [ ] **Step 2: Add a generated-files test for the historical-tree fallback**

Add to `core/__tests__/git-state.test.ts`:

```ts
test('the historical-tree attribute fallback uses and removes a host temporary directory', async () => {
  await withGitTestEnvironment(async () => {
    await using directory = await createTemporaryDirectory('codiff-host-attributes-');
    const repo = await realpath(directory.path);
    await git(repo, ['init']);
    await writeRepoFile(repo, '.gitattributes', 'generated.ts linguist-generated\n');
    await writeRepoFile(repo, 'generated.ts', 'export {};\n');
    await commitAll(repo, 'Initial commit.');

    const { calls, host: recordingHost } = createRecordingHost({
      ...host,
      // Simulate Git < 2.40, which rejects `check-attr --source`.
      exec: (command, args, options) =>
        args.includes('--source')
          ? Promise.reject(new Error('unknown option `source`'))
          : host.exec(command, args, options),
    });
    const states = await readGeneratedAttributeStates(
      recordingHost,
      repo,
      ['generated.ts'],
      'HEAD',
    );

    expect(states.get('generated.ts')).toBe(true);
    const temporary = calls.find(({ method }) => method === 'mkdtemp');
    expect(temporary).toBeDefined();
    expect(calls.some(({ method }) => method === 'rm')).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `vp test electron/__tests__/definition-search.test.ts core/__tests__/git-state.test.ts -t "grep|temporary directory"`
Expected: FAIL; `runBoundedGitGrep` still uses `spawnProcess`, and `generated-files.cjs` still uses `node:fs/promises` `mkdtemp`.

- [ ] **Step 4: Spawn `git grep` through the host**

In `electron/definition-search.cjs`, change `runBoundedGitGrep`:

```js
/**
 * @param {RepositoryHost} host
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{maxMatches?: number; maxOutputBytes?: number; signal?: AbortSignal; timeoutMs?: number}} [options]
 * @returns {Promise<string>}
 */
const runBoundedGitGrep = (
  host,
  repoPath,
  args,
  {
    maxMatches = MAX_SEARCH_MATCHES,
    maxOutputBytes = MAX_SEARCH_OUTPUT_BYTES,
    signal,
    timeoutMs = SEARCH_TIMEOUT_MS,
  } = {},
) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = host.spawn('git', ['-C', repoPath, ...args]);
    child.stdin.end();
```

The rest of the function body is unchanged. Remove the `node:child_process` import.

- [ ] **Step 5: Use a host temporary directory for the attribute fallback**

In `electron/generated-files.cjs`:

```js
const readGeneratedAttributeStatesFromTree = async (host, repoRoot, paths, source) => {
  const temporaryDirectory = await host.mkdtemp('codiff-generated-files-');
  const env = { GIT_INDEX_FILE: join(temporaryDirectory, 'index') };

  try {
    await gitBufferWithInput(host, repoRoot, ['read-tree', source], Buffer.alloc(0), { env });
    return await checkGeneratedAttributeStates(host, repoRoot, paths, ['--cached'], env);
  } finally {
    await host.rm(temporaryDirectory, { force: true, recursive: true });
  }
};
```

Change `checkGeneratedAttributeStates`'s `env` JSDoc type to `Readonly<Record<string, string>> | undefined`. Remove the `node:fs/promises` and `node:os` imports.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `vp test electron/__tests__/definition-search.test.ts core/__tests__/git-state.test.ts`
Expected: PASS. Run the type-check; expected clean.

- [ ] **Step 7: Check, build and commit**

```bash
vp check --fix
vpr build
git add electron/definition-search.cjs electron/generated-files.cjs electron/__tests__/definition-search.test.ts core/__tests__/git-state.test.ts
git commit -m "Run git grep and temporary indexes on the repository host."
```

---

### Task 7: Commit through the host

**Files:**

- Modify: `electron/walkthrough-commit.cjs`
- Test: `electron/__tests__/walkthrough-commit.test.ts`

**Interfaces:**

- Consumes: `host.spawnPty`, `host.mkdtemp`, `host.writeFile`, `host.rm` (Task 1); `createWalkthroughCommit(host, repoPath, request, onOutput?)` (Task 3).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Add to `electron/__tests__/walkthrough-commit.test.ts` (import `createRecordingHost` from `../../core/__tests__/helpers/recording-host.ts`):

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test electron/__tests__/walkthrough-commit.test.ts -t "through the host"`
Expected: FAIL; no `spawnPty` or `mkdtemp` call is recorded because the module still uses `node:fs` and `pty.cjs` directly.

- [ ] **Step 3: Route the commit through the host**

In `electron/walkthrough-commit.cjs`:

1. Remove the `node:fs`, `node:os` and `./pty.cjs` imports. Keep `join` from `node:path`.
2. Change `gitStreaming`:

   ```js
   /**
    * @param {RepositoryHost} host
    * @param {string} repoPath
    * @param {ReadonlyArray<string>} args
    * @param {((chunk: string) => void) | undefined} onOutput
    * @returns {Promise<void>}
    */
   const gitStreaming = (host, repoPath, args, onOutput) =>
     new Promise((resolve, reject) => {
       /** @type {import('node-pty').IPty} */
       let child;
       try {
         child = host.spawnPty('git', ['-C', repoPath, ...args], {
           cols: TERMINAL_COLS,
           cwd: repoPath,
           name: 'xterm-256color',
           rows: TERMINAL_ROWS,
         });
       } catch (error) {
         reject(error instanceof Error ? error : new Error(String(error)));
         return;
       }
   ```

   The rest of `gitStreaming` is unchanged.

3. Replace the message-file block inside `createWalkthroughCommit`:

   ```js
   await git(host, repoPath, ['add', '--', ...paths]);
   const tempDirectory = await host.mkdtemp('codiff-commit-message-');
   const messagePath = join(tempDirectory, 'message.txt');
   try {
     await host.writeFile(messagePath, message);
     await gitStreaming(host, repoPath, ['commit', '-F', messagePath, '--', ...paths], onOutput);
   } finally {
     await host.rm(tempDirectory, { force: true, recursive: true });
   }
   ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test electron/__tests__/walkthrough-commit.test.ts`
Expected: PASS, including the existing hook-output tests. Run the type-check; expected clean.

- [ ] **Step 5: Check, build and commit**

```bash
vp check --fix
vpr build
git add electron/walkthrough-commit.cjs electron/__tests__/walkthrough-commit.test.ts
git commit -m "Create walkthrough commits through the repository host."
```

---

### Task 8: Read and save edited files through the host

**Files:**

- Modify: `electron/repository-file.cjs`
- Modify: `electron/main.cjs` (`codiff:getRepositoryFile`, `codiff:saveRepositoryFile` handlers)
- Test: `electron/__tests__/repository-file.test.ts`

**Interfaces:**

- Consumes: `host.realpath`, `host.stat`, `host.readFile`, `host.writeFile({exclusive, mode})`, `host.rename`, `host.rm`.
- Produces: `resolveRepositoryFile(host, repositoryRoot, path)`, `readRepositoryFile(host, repositoryRoot, path)`, `writeRepositoryFile(host, repositoryRoot, request)`.

- [ ] **Step 1: Update the tests and add a host-routing test**

In `electron/__tests__/repository-file.test.ts`, add the `host` setup from Task 3 Step 1, prefix every call of `readRepositoryFile`, `writeRepositoryFile` and `resolveRepositoryFile` with `host` (use the Task 3 `perl` pattern with these three names), and add `host: RepositoryHost` to their declared types. Then add:

```ts
test('saves edited files through the host with an atomic rename', async () => {
  await using directory = await createTemporaryDirectory('codiff-repository-file-host-');
  const root = await realpath(directory.path);
  await writeFile(join(root, 'a.txt'), 'before\n');
  await chmod(join(root, 'a.txt'), 0o755);
  const { calls, host: recordingHost } = createRecordingHost(host);

  const current = await readRepositoryFile(recordingHost, root, 'a.txt');
  const result = await writeRepositoryFile(recordingHost, root, {
    baseVersion: current.version,
    content: 'after\n',
    path: 'a.txt',
    root: current.root,
  });

  expect(result.status).toBe('saved');
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('after\n');
  expect((await stat(join(root, 'a.txt'))).mode & 0o777).toBe(0o755);
  const write = calls.find(({ method }) => method === 'writeFile');
  expect(write?.args[2]).toEqual({ exclusive: true, mode: 0o755 });
  expect(calls.some(({ method }) => method === 'rename')).toBe(true);
});
```

The request fields match `SaveRepositoryFileRequest` in `core/types.ts` (`baseVersion`, `content`, `path`, `root`). Import `chmod`, `readFile`, `realpath`, `stat` and `writeFile` from `node:fs/promises`, `join` from `node:path`, `createTemporaryDirectory` from `../../core/__tests__/helpers/resources.ts` and `createRecordingHost` from `../../core/__tests__/helpers/recording-host.ts` where the file does not already import them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test electron/__tests__/repository-file.test.ts`
Expected: FAIL; the functions do not accept `host` yet (paths resolve against `[object Object]`).

- [ ] **Step 3: Route `repository-file.cjs` through the host**

Change the import to `const { createHash, randomUUID } = require('node:crypto');` plus the `node:path` import, and remove `node:fs/promises`. Then:

```js
/** @param {RepositoryHost} host @param {string} repositoryRoot @param {string} path */
const resolveRepositoryFile = async (host, repositoryRoot, path) => {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository file path.');
  }
  const root = await host.realpath(repositoryRoot);
  const requestedPath = resolve(root, path);
  const absolutePath = await host.realpath(requestedPath);
  // ...the containment and `.git` checks below are unchanged...
};

/** @param {RepositoryHost} host @param {{absolutePath: string; path: string; root: string}} resolved */
const readResolvedFile = async (host, resolved) => {
  const fileStat = await host.stat(resolved.absolutePath);
  if (fileStat.type !== 'file') {
    throw new Error('Only regular files can be edited.');
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error('File exceeds the 2 MB editing limit.');
  }
  const bytes = await host.readFile(resolved.absolutePath);
  // ...UTF-8 validation and return value unchanged...
};
```

`readRepositoryFile(host, repositoryRoot, path)` passes `host` to both. In `writeRepositoryFile(host, repositoryRoot, request)`, replace the temporary-file block with:

```js
const mode = (await host.stat(resolved.absolutePath)).mode & 0o7777;
await host.writeFile(temporaryPath, request.content, { exclusive: true, mode });
try {
  // Check again after preparing the replacement, including symlink retargets.
  const latestResolved = await resolveRepositoryFile(host, repositoryRoot, request.path);
  const latest = await readResolvedFile(host, latestResolved);
  if (latestResolved.absolutePath !== resolved.absolutePath || latest.version !== current.version) {
    await host.rm(temporaryPath, { force: true });
    return { document: latest, status: 'conflict' };
  }
  await host.rename(temporaryPath, resolved.absolutePath);
} catch (error) {
  await host.rm(temporaryPath, { force: true }).catch(() => {});
  throw error;
}
return { document: await readResolvedFile(host, resolved), status: 'saved' };
```

`temporaryPath` keeps its current construction (`resolve(dirname(...), \`.${basename(...)}.${process.pid}.${randomUUID()}.tmp\`)`). `process.pid` is only a uniqueness hint and is fine on any host.

- [ ] **Step 4: Update the IPC handlers**

In `electron/main.cjs`, `codiff:getRepositoryFile` and `codiff:saveRepositoryFile` destructure `{ host, repositoryPath }` from `getWindowRepository(event.sender.id)` and pass `host` first to `readRepositoryFile` / `writeRepositoryFile`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `vp test electron/__tests__/repository-file.test.ts`
Expected: PASS, including the existing escape, `.git`, symlink-retarget and conflict tests. Run the type-check; expected clean.

- [ ] **Step 6: Check, build and commit**

```bash
vp check --fix
vpr build
git add electron/repository-file.cjs electron/main.cjs electron/__tests__/repository-file.test.ts
git commit -m "Read and save edited files through the repository host."
```

---

### Task 9: Resolve window identity and review remotes through the host

**Files:**

- Modify: `electron/review-source.cjs`
- Modify: `electron/window-identity.cjs`
- Modify: `electron/git-state/merge-request.cjs` (`selectMergeRequestRemote`)
- Modify: `electron/main/command-line.cjs` (keep sync, switch to the pure helpers)
- Modify: `bin/arguments.js` (keep sync, switch to the pure helpers)
- Modify: `electron/main.cjs`
- Test: `electron/__tests__/review-source.test.ts`, `electron/__tests__/window-identity.test.ts`, `core/__tests__/gitlab.test.ts`, `electron/__tests__/command-line.test.ts`, `core/__tests__/codiff-cli.test.ts`

**Interfaces:**

- Consumes: Task 3 signatures, `host.realpath`.
- Produces:
  - `review-source.cjs`: `parseReviewRemotes(raw: string): Array<ReviewRemote>` (pure), `selectReviewUrl(remotes, number, provider?): string` (pure; throws the same errors as today), `readReviewRemotes(host, repositoryPath): Promise<Array<ReviewRemote>>`, `resolveReviewUrl(host, repositoryPath, number, provider?): Promise<string>`, `readLocalReviewRemotesSync(repositoryPath): Array<ReviewRemote>` and `resolveLocalReviewUrlSync(repositoryPath, number, provider?): string` (used only by CLI parsing).
  - `window-identity.cjs`: `getWindowIdentity(host, repositoryPath, launchOptions?): Promise<WindowIdentity | null>`, `getWindowIdentityForSource(host, repositoryPath, source)`, `getWindowIdentityForRepositoryState(host, state): Promise<WindowIdentity | null>`. Keys are unchanged: `${repositoryRoot}\0${sourceKey}`.
  - `main.cjs`: `focusOrCreateWindow(host, repositoryPath, launchOptions?)` and `createWindow(host, repositoryPath, launchOptions, identity)` (identity required; async callers compute it).

- [ ] **Step 1: Update and add tests**

1. `electron/__tests__/review-source.test.ts`: add the `host` setup; calls to `resolveReviewUrl(path, …)` become `await resolveReviewUrl(host, path, …)` and `readReviewRemotes(path)` becomes `await readReviewRemotes(host, path)` (tests become `async`). Add:

   ```ts
   test('parseReviewRemotes and selectReviewUrl resolve a review without Git', () => {
     const remotes = parseReviewRemotes(
       'origin\tgit@github.com:nkzw-tech/codiff.git (fetch)\norigin\tgit@github.com:nkzw-tech/codiff.git (push)\n',
     );
     expect(selectReviewUrl(remotes, 12)).toBe('https://github.com/nkzw-tech/codiff/pull/12');
     expect(() => selectReviewUrl([], 12)).toThrow('Could not resolve review #12');
   });
   ```

2. `electron/__tests__/window-identity.test.ts`: add the `host` setup; every `getWindowIdentity(path, options)` becomes `await getWindowIdentity(host, path, options)`, likewise `getWindowIdentityForSource` and `getWindowIdentityForRepositoryState(host, state)`. Expected key values stay exactly as they are.
3. `core/__tests__/gitlab.test.ts`: calls that reach `selectMergeRequestRemote` already pass `host` after Task 3; no extra change unless the type-check reports one.
4. `electron/__tests__/command-line.test.ts` and `core/__tests__/codiff-cli.test.ts`: no signature change; they must keep passing unchanged.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test electron/__tests__/review-source.test.ts electron/__tests__/window-identity.test.ts`
Expected: FAIL; `parseReviewRemotes`/`selectReviewUrl` are not exported, and the async signatures do not exist.

- [ ] **Step 3: Split `review-source.cjs` into pure helpers plus readers**

Replace `readReviewRemotes` and `resolveReviewUrl` (lines 124-180) with:

```js
/**
 * @typedef {{direction: string; name: string} & NonNullable<ReturnType<typeof parseRemoteUrl>>} ReviewRemote
 */

/** @param {string} raw @returns {Array<ReviewRemote>} */
const parseReviewRemotes = (raw) => {
  /** @type {Array<ReviewRemote>} */
  const remotes = [];
  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    const remote = match ? parseRemoteUrl(match[2]) : null;
    if (match && remote) {
      remotes.push({ direction: match[3], name: match[1], ...remote });
    }
  }
  return remotes;
};

/**
 * @param {ReadonlyArray<ReviewRemote>} remotes
 * @param {number} number
 * @param {ReviewProvider | undefined} [provider]
 */
const selectReviewUrl = (remotes, number, provider) => {
  const remote = remotes
    .filter((candidate) => !provider || candidate.provider === provider)
    .sort((left, right) => remotePriority(left) - remotePriority(right))[0];
  if (!remote) {
    throw new Error(
      `Could not resolve ${provider === 'gitlab' ? 'MR' : provider === 'github' ? 'PR' : 'review'} #${number} from this repository's remotes.`,
    );
  }
  return remote.provider === 'github'
    ? `https://github.com/${remote.projectPath}/pull/${number}`
    : `https://${remote.host}/${remote.projectPath}/-/merge_requests/${number}`;
};

/** @param {number} number */
const createUnresolvedReviewError = (number) =>
  new Error(
    `Could not resolve review #${number}. Run codiff inside a Git repository or pass a full pull/merge request URL.`,
  );

/** @param {RepositoryHost} host @param {string} repositoryPath */
const readReviewRemotes = async (host, repositoryPath) => {
  const root = (await git(host, repositoryPath, ['rev-parse', '--show-toplevel'])).trim();
  return parseReviewRemotes(await git(host, root, ['remote', '-v']));
};

/**
 * @param {RepositoryHost} host
 * @param {string} repositoryPath
 * @param {number} number
 * @param {ReviewProvider | undefined} [provider]
 */
const resolveReviewUrl = async (host, repositoryPath, number, provider) => {
  let remotes;
  try {
    remotes = await readReviewRemotes(host, repositoryPath);
  } catch {
    throw createUnresolvedReviewError(number);
  }
  return selectReviewUrl(remotes, number, provider);
};

/**
 * Synchronous local variant for CLI argument parsing, which runs on this
 * machine before any repository host exists.
 *
 * @param {string} repositoryPath
 */
const readLocalReviewRemotesSync = (repositoryPath) => {
  const root = execFileSync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  return parseReviewRemotes(
    execFileSync('git', ['-C', root, 'remote', '-v'], { encoding: 'utf8' }),
  );
};

/**
 * @param {string} repositoryPath
 * @param {number} number
 * @param {ReviewProvider | undefined} [provider]
 */
const resolveLocalReviewUrlSync = (repositoryPath, number, provider) => {
  let remotes;
  try {
    remotes = readLocalReviewRemotesSync(repositoryPath);
  } catch {
    throw createUnresolvedReviewError(number);
  }
  return selectReviewUrl(remotes, number, provider);
};
```

Import `git` from `./git-state/common.cjs` and add the `RepositoryHost` typedef. Export `parseRemoteUrl`, `parseReviewUrl`, `parseReviewRemotes`, `selectReviewUrl`, `readReviewRemotes`, `resolveReviewUrl`, `readLocalReviewRemotesSync`, `resolveLocalReviewUrlSync`. Requiring `./git-state/common.cjs` from `review-source.cjs` creates no cycle: `common.cjs` only requires Node built-ins.

- [ ] **Step 4: Point the CLI parsers at the sync local helpers**

In `electron/main/command-line.cjs` and `bin/arguments.js`, replace `resolveReviewUrl(repositoryPath, number, provider)` with `resolveLocalReviewUrlSync(repositoryPath, number, provider)` (update the import/destructuring). No other change.

- [ ] **Step 5: Make `selectMergeRequestRemote` async**

In `electron/git-state/merge-request.cjs`, change `selectMergeRequestRemote(repoRoot, mergeRequest)` to `async (host, repoRoot, mergeRequest)` and `readReviewRemotes(repoRoot)` to `await readReviewRemotes(host, repoRoot)`; `await` it at its call sites (the type-check lists them).

- [ ] **Step 6: Make window identity async and host-based**

In `electron/window-identity.cjs`:

```js
/** @param {RepositoryHost} host @param {string} path */
const getHostRealPath = async (host, path) => {
  try {
    return await host.realpath(path);
  } catch {
    return path;
  }
};

/** @param {RepositoryHost} host @param {string} repositoryPath */
const resolveRepositoryRoot = async (host, repositoryPath) => {
  const resolvedPath = resolve(repositoryPath);
  try {
    return await getHostRealPath(
      host,
      (await git(host, resolvedPath, ['rev-parse', '--show-toplevel'])).trim(),
    );
  } catch {
    return getHostRealPath(host, resolvedPath);
  }
};

/** @param {RepositoryHost} host @param {string} repositoryRoot @param {string} ref */
const resolveCommitRef = async (host, repositoryRoot, ref) => {
  try {
    return (await git(host, repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`]))
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
};

/** @param {RepositoryHost} host @param {string} repositoryRoot */
const hasWorkingTreeChanges = async (host, repositoryRoot) => {
  try {
    return Boolean(
      await git(host, repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
      ]),
    );
  } catch {
    return false;
  }
};

/** @param {RepositoryHost} host @param {string} repositoryRoot @param {string} baseRef @param {string} headRef */
const resolveMergeBase = async (host, repositoryRoot, baseRef, headRef) => {
  try {
    return (await git(host, repositoryRoot, ['merge-base', baseRef, headRef])).trim().toLowerCase();
  } catch {
    return null;
  }
};
```

`getSourceKey(host, repositoryRoot, source)` becomes async and awaits `resolveCommitRef`/`resolveMergeBase`. `getWindowIdentity(host, repositoryPath, launchOptions)` becomes async; its `planFile` branch keeps using the local `getRealPath` (plan files are local), and the rest awaits `resolveRepositoryRoot`, `hasWorkingTreeChanges` and `resolveCommitRef`. `getWindowIdentityForSource(host, repositoryPath, source)` and `getWindowIdentityForRepositoryState(host, state)` (awaiting `getHostRealPath(host, state.root)`) become async. Remove `execFileSync`; keep `realpathSync` for the plan-file branch. Import `git` from `./git-state/common.cjs`.

- [ ] **Step 7: Update `main.cjs` window creation**

1. `createWindow(host, repositoryPath, launchOptions, identity)`: remove the default for `identity`; store `windowRepositories.set(webContentsId, { host, repositoryPath: identity?.repositoryRoot || repositoryPath })`; pass `host` to `readInitialRepositoryStateWithConfig`.
2. `focusOrCreateWindow` becomes `async (host, repositoryPath, launchOptions = {…})`, starts with `const identity = await getWindowIdentity(host, repositoryPath, launchOptions);`, stores `{ host, repositoryPath: … }` in the matching-window branch and calls `createWindow(host, repositoryPath, launchOptions, identity)`.
3. Every caller (`openRepositoryFolder`, `second-instance`, `ready`, `activate`) passes `localHost` and uses `void focusOrCreateWindow(localHost, …)` where the result is unused.
4. `storeResolvedRepositoryState` becomes async: `const identity = await getWindowIdentityForRepositoryState(host, state)` with `host` from `windowRepositories.get(webContentsId)`. Its caller(s) `void` or `await` it; it must still set `windowRepositories` synchronously before awaiting.
5. `codiff:resolvePullRequestUrl` returns `resolveReviewUrl(host, repositoryPath, Number(number[1]))`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `vp test`
Expected: PASS, with unchanged identity keys in `window-identity.test.ts` and unchanged CLI tests. Run the type-check; expected clean.

- [ ] **Step 9: Smoke-test window reuse**

Run `vpr build`, then launch `node ./bin/codiff.js` twice from this repository: the second launch must focus the existing window instead of opening a new one. Then launch `node ./bin/codiff.js HEAD~1` and confirm a separate commit window opens, and running it again focuses that window.

- [ ] **Step 10: Check and commit**

```bash
vp check --fix
vpr build
git add electron bin core/__tests__
git commit -m "Resolve window identity and review remotes through the repository host."
```

---

### Task 10: Guard the host boundary

**Files:**

- Create: `electron/__tests__/repository-host-boundary.test.ts`

**Interfaces:**

- Consumes: the final module layout from Tasks 3-9.
- Produces: a test that fails when a repository module imports `fs`, `child_process`, `os` or the PTY module directly.

- [ ] **Step 1: Write the guardrail test**

Create `electron/__tests__/repository-host-boundary.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test } from 'vite-plus/test';

const electronRoot = join(import.meta.dirname, '..');

// Modules that operate on a repository must reach its machine only through the
// RepositoryHost they are given, so the same code works for local and SSH hosts.
const guardedModules = [
  ...readdirSync(join(electronRoot, 'git-state'))
    .filter((name) => name.endsWith('.cjs'))
    .map((name) => join('git-state', name)),
  'definition-search.cjs',
  'generated-files.cjs',
  'git-state.cjs',
  'repository-file.cjs',
  'repository-watcher.cjs',
  'walkthrough-commit.cjs',
];

const forbiddenModules = [
  'node:child_process',
  'node:fs',
  'node:fs/promises',
  'node:os',
  './pty.cjs',
  '../pty.cjs',
];

// PR/MR review runs the local `gh`/`glab` CLIs and is not supported for remote
// repositories, so those two modules may spawn local processes.
const allowedImports: Readonly<Record<string, ReadonlyArray<string>>> = {
  [join('git-state', 'merge-request.cjs')]: ['node:child_process', 'node:os'],
  [join('git-state', 'pull-request.cjs')]: ['node:child_process', 'node:os'],
};

test.each(guardedModules)('%s reaches the repository only through its host', (module) => {
  const source = readFileSync(join(electronRoot, module), 'utf8');
  const imported = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1],
  );
  const allowed = allowedImports[module] ?? [];
  expect(
    imported.filter((name) => forbiddenModules.includes(name) && !allowed.includes(name)),
    `${relative(electronRoot, join(electronRoot, module))} must use RepositoryHost`,
  ).toEqual([]);
});
```

- [ ] **Step 2: Verify the guard catches a violation**

Temporarily add `const { readFileSync } = require('node:fs');` to the top of `electron/definition-search.cjs` and run `vp test electron/__tests__/repository-host-boundary.test.ts`.
Expected: FAIL for `definition-search.cjs`, listing `node:fs`. Remove the line again.

- [ ] **Step 3: Run the guard against the real code**

Run: `vp test electron/__tests__/repository-host-boundary.test.ts`
Expected: PASS. If a module fails, route its remaining file or process access through the host as in Tasks 4-8 rather than extending the allowlist.

- [ ] **Step 4: Run everything**

Run the type-check, `vp check`, then `vp test`.
Expected: all clean and passing.

- [ ] **Step 5: Check, build and commit**

```bash
vp check --fix
vpr build
git add electron/__tests__/repository-host-boundary.test.ts
git commit -m "Guard repository modules against direct file and process access."
```

---

## Follow-on plans

Phases 2-5 of the spec each get their own plan once this one lands, because their code depends on the exact signatures above:

2. `SshHost` transport (escaping, master connection, operations including GNU/BSD-aware `lstat`, cancellation, concurrency, typed errors, test `sshd`, contract suite reuse, failure-mode tests).
3. Entry points (CLI remote targets and terminal master setup, host-qualified identity keys, Open Remote Repository dialog, title indicator, disconnected banner).
4. Remote walkthroughs (`readdir`, `readFileTail`, `getEnvironment`, `resolveCommand`; agent runners and session-context readers through the host).
5. Docs and benchmarks.
