# SSH Remote Repositories, Phase 2: `SshHost` Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `SshHost` that implements `RepositoryHost` over the system `ssh` binary with one multiplexed connection, and prove it by running the shared host contract and the existing git-state suites against a throwaway local `sshd`.

**Architecture:** Four focused modules under `electron/host/`:

- `shell-quote.cjs` turns a command plus argv into a POSIX script, and wraps that script for the remote login shell's dialect.
- `host-errors.cjs` holds the typed errors and classifies ssh failures.
- `ssh-connection.cjs` owns the ssh invocations: the master lifecycle, control commands and client spawns.
- `ssh-host.cjs` implements every `RepositoryHost` method as a remote script over that connection, and adds remote PID cancellation and a channel limiter.

Tests start a non-root `sshd` on `127.0.0.1` with a generated key. `SshHost` is not wired into the app or CLI in this phase; that is Phase 3.

**Tech Stack:** Node.js 24 CommonJS with `// @ts-check` JSDoc, OpenSSH client and server (`ssh`, `sshd`, `ssh-keygen`), Vite+ (`vp`) tests via `vite-plus/test`, GitHub Actions on Ubuntu.

**Spec:** `docs/superpowers/specs/2026-10-10-ssh-remote-repositories-design.md` (this plan implements delivery phase 2). Read `docs/superpowers/plans/2026-10-10-ssh-remote-phase-1-repository-host.md` for the `RepositoryHost` interface. Its "Carried forward from the Phase 1 final review → Phase 2" list is fully covered by Tasks 1 and 2 here.

## Global Constraints

- Platforms: macOS and Linux only. Use the system `ssh` binary. Add no new dependencies.
- SSH options, copied from the spec:
  - Every invocation passes `-o ControlPath=<controlDirectory>/%C -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o BatchMode=yes`. `controlDirectory` defaults to `~/.codiff/ssh`, created with mode `0700`.
  - The master passes `-o ControlMaster=yes -o ControlPersist=yes -f -N`.
  - Clients pass `-o ControlMaster=auto -o ControlPersist=no`.
  - The app never prompts: `BatchMode=yes` is always set.
- Connect sequence:
  1. Adopt a live master (`ssh -O check`) or start one.
  2. Read `$SHELL` to choose the escaping dialect.
  3. Verify that `git` (and `realpath`) resolve on the remote `PATH`.

  Capturing the remote login environment is Phase 4.

- Escaping:
  - The inner script is POSIX `sh`, with every argument single-quoted (`'` becomes `'\''`) and env vars passed as `env 'K=V'`.
  - The outer wrapper is `exec /bin/sh -c <script quoted for the login shell>`. POSIX quoting applies for `sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh` and `ash`. For `fish`, use single quotes with `\` → `\\` and `'` → `\'`.
  - Any other shell is rejected. Arguments may not contain NUL.
- Error messages (exact text):
  - `HostAuthRequiredError`: "<alias> needs interactive login. Run `codiff <alias>:<path>` from a terminal."
  - `HostUnreachableError`: ssh's own error output, verbatim and trimmed.
  - `HostDisconnectedError`: "Lost connection to <alias>."
  - `UnsupportedRemoteShellError`: "Codiff needs a POSIX or fish login shell on <alias>."
  - `RemoteCommandMissingError`: "<command> isn't installed on <alias>."
- A non-zero remote command exit is a command failure, not an SSH failure. Exit status 255 is classified as an SSH failure only when `ssh -O check` also fails.
- Cancellation: commands started by `exec` (with a `signal`), `spawn` and `spawnPty` announce their PID first. Killing them also runs `kill -TERM <pid>` on the remote, because closing the local `ssh` does not stop the remote process. (This was verified while planning: the remote `sleep` survived a local kill.)
- No user-visible behavior change for local repositories. `LocalHost` behavior stays as-is, except for the type narrowing in Task 1.
- Type-check gate: `vp exec tsc --noEmit -p tsconfig.json` has pre-existing errors on `main`. Before Task 1, record the per-file error counts, as the Phase 1 run did. No file may gain errors, and new files must have none.
- Known baseline: the full `vp test` has exactly 2 environment-caused failures on this Mac.
  - `core/__tests__/git-state.test.ts` "clean implicit walkthrough reads use a bounded number of Git processes": 16 > 14 under Apple Git 2.39.5. It must not exceed 16.
  - `core/__tests__/codiff-completions.test.ts` "stops offering refs once the source is a flag in fish".
- Toolchain: dependencies are installed project-locally. Run `export PATH="$PWD/node_modules/.bin:$PATH"` before `vp`, `vpr` or `tsc`.
- Workflow:
  - After each task, run `vp check --fix`, then `vpr build`.
  - Commit on the current branch with a one-sentence message ending in a period and no `Co-Authored-By` or other attribution trailer.
  - Never stage `package.json`; it has the user's uncommitted version bump.
  - Stage files by explicit path.

## Spec deviations made while planning

1. **Channel limit 6, not 8.** sshd's default `MaxSessions` is 10.
   - Queued operations (`exec` and file operations) use at most 6 channels.
   - That leaves room for a long-lived `git grep` spawn, a commit PTY, remote kill requests and a fallback session.
   - At 8 queued channels plus those, a kill request could be refused at exactly the moment it is needed.
2. **The app-started master logs to a file** (`ssh -E <controlDirectory>/<alias>.log`). `ssh -f` keeps a forked master that holds any output pipes open, so its stderr cannot be piped. The log file still captures auth and connect errors for classification.
3. **Noisy shell startup files are detected at connect.**
   - If the remote login shell prints output in non-interactive sessions, every command's stdout would be corrupted. (Common causes are an `echo` in `.bashrc` or `.zshenv`.)
   - `connectSshHost` checks that a probe prints exactly one line and otherwise throws `RemoteShellNoiseError`: "<alias>'s shell startup files print output in non-interactive sessions, which breaks Codiff. Only print output in interactive shells."
4. **Classification is by phase.**
   - During connect, authentication patterns produce `HostAuthRequiredError` and any other failure produces `HostUnreachableError`, carrying ssh's own error output.
   - During an established session, authentication patterns produce `HostAuthRequiredError` and anything else produces `HostDisconnectedError`.
5. **Contract decisions (Phase 1 carry-forward):**
   - `env` merges over the ssh session's non-interactive environment. Phase 4 adds the captured login environment for agents.
   - `writeFile({exclusive})` guarantees exclusive creation and the exact mode. `fsync` durability is not part of the contract; `LocalHost` keeps its `fsync` as an implementation detail.
   - `lstatMany` maps any per-path failure to `null`.
6. **`stat` with GNU/BSD detection.** `lstat` uses `stat -c '%f %s %i %.9Y %.9Z'` (GNU) or `stat -f '%Xp %z %i %Fm %Fc'` (BSD), detected at connect. The spec's `test`/`wc -c` approach cannot produce `mode`, `ino` or sub-second times. Phase 1 already noted this.
7. **`realpath` is required on the remote** (GNU coreutils, macOS 13+ and busybox all have it). It is checked at connect along with `git`.

## Review Focus

1. **File names with quotes, spaces, `$()`, backticks, backslashes, globs or Unicode** in a repository: every operation must work on them exactly as locally. This is pinned by a contract test (Task 1) that runs on both hosts (Task 8).
2. **A file name containing a newline inside a batched `lstatMany` or `readFiles`:** results must stay aligned with the input order. Pinned by a contract test (Task 1) on both hosts (Task 8).
3. **A remote shell whose startup files print text** (very common in `.bashrc`): connect must fail with `RemoteShellNoiseError` instead of corrupting diffs. Pinned in Task 9.
4. **A remote command that itself exits 255** (for example a `git` hook): it must be reported as that command's failure, not as a lost connection. Pinned in Task 9.
5. **The master connection dies mid-session** (laptop sleep, network change): the next operation must still succeed through the client fallback, and the master must come back on its own. Pinned in Task 9.

---

## File Structure

| File                                                     | Status | Responsibility                                                                                                                                 |
| -------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron/host/repository-host.cjs`                      | Modify | Narrow `spawn`/`spawnPty` to `HostProcess`/`HostPty`; document the contract decisions.                                                         |
| `electron/host/shell-quote.cjs`                          | Create | POSIX and fish quoting, login-shell dialect detection, command script builder, PID marker.                                                     |
| `electron/host/host-errors.cjs`                          | Create | Typed host errors and the ssh failure classifier.                                                                                              |
| `electron/host/ssh-connection.cjs`                       | Create | ssh argument building, master check/start/exit, client spawning, single-flight `ensureMaster`.                                                 |
| `electron/host/ssh-host.cjs`                             | Create | `connectSshHost` and `createSshHost`: every `RepositoryHost` method over the connection, PID cancellation, channel limiter, master keep-alive. |
| `electron/main/window-launch-queue.cjs`                  | Create | Serial window-launch queue with a per-launch timeout (Phase 1 carry-forward).                                                                  |
| `electron/walkthrough-commit.cjs`                        | Modify | Best-effort temp-directory cleanup (Phase 1 carry-forward).                                                                                    |
| `electron/main.cjs`                                      | Modify | Use `window-launch-queue.cjs`.                                                                                                                 |
| `electron/__tests__/helpers/repository-host-contract.ts` | Modify | New contract tests: error shape, sub-second mtime, empty batches, special file names, newline in batched names.                                |
| `electron/__tests__/helpers/test-sshd.ts`                | Create | Start/stop a throwaway non-root `sshd` with generated keys and an ssh config.                                                                  |
| `core/__tests__/helpers/test-host.ts`                    | Create | `host` for test suites: `LocalHost` by default, `SshHost` against the test `sshd` when `CODIFF_TEST_HOST=ssh`.                                 |
| `electron/__tests__/shell-quote.test.ts`                 | Create | Real-shell round trips for every dialect.                                                                                                      |
| `electron/__tests__/host-errors.test.ts`                 | Create | Error messages and classification.                                                                                                             |
| `electron/__tests__/test-sshd.test.ts`                   | Create | Harness self-test.                                                                                                                             |
| `electron/__tests__/ssh-connection.test.ts`              | Create | Master lifecycle and client runs against the test `sshd`.                                                                                      |
| `electron/__tests__/ssh-host.test.ts`                    | Create | `SshHost` unit parsers, process tests, and the full contract against the test `sshd`.                                                          |
| `electron/__tests__/ssh-host-failures.test.ts`           | Create | Connect and session failure modes.                                                                                                             |
| `electron/__tests__/window-launch-queue.test.ts`         | Create | Queue ordering and timeout.                                                                                                                    |
| `.github/workflows/test.yml`                             | Modify | Install `openssh-server`, `zsh`, `fish`; run the git-state suites over SSH.                                                                    |
| Existing tests using a host (listed in Task 10)          | Modify | Import `host` from `test-host.ts`.                                                                                                             |

---

### Task 1: Narrow process types and pin the contract

**Files:**

- Modify: `electron/host/repository-host.cjs`
- Modify: `electron/walkthrough-commit.cjs:51` (the `@type` on `child`)
- Modify: `electron/__tests__/helpers/repository-host-contract.ts`
- Test: `electron/__tests__/local-host.test.ts` (runs the contract)

**Interfaces:**

- Consumes: the Phase 1 `RepositoryHost`, `createLocalHost`, and `defineRepositoryHostContract(name, createFixture)`.
- Produces:
  - `HostProcess = {stdin: Writable; stdout: Readable; stderr: Readable; kill: () => unknown; on: (event: string, listener: (...args: Array<any>) => void) => unknown}`
  - `HostPty = {onData: (listener: (data: string) => void) => {dispose: () => void}; onExit: (listener: (event: {exitCode: number}) => void) => {dispose: () => void}; kill: () => void}`
  - `RepositoryHost['spawn']` returns `HostProcess`, and `RepositoryHost['spawnPty']` returns `HostPty`.

- [ ] **Step 1: Record the type-check baseline**

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
vp exec tsc --noEmit -p tsconfig.json > /tmp/codiff-tsc-baseline.txt 2>&1; grep "error TS" /tmp/codiff-tsc-baseline.txt | grep -oE "^[^(]+\(" | sort | uniq -c > /tmp/codiff-tsc-baseline-by-file.txt; grep -c "error TS" /tmp/codiff-tsc-baseline.txt
```

Write the printed total in your report. Later "type-check gate" steps rerun the same commands into `/tmp/codiff-tsc-current*.txt`. They check that no file's count exceeds its baseline count, and that no file outside the baseline list has errors.

- [ ] **Step 2: Add the failing contract tests**

Append these tests inside `defineRepositoryHostContract`, after the last existing test in `electron/__tests__/helpers/repository-host-contract.ts`:

```ts
test(`${name}: exec without input reports the command and its stderr`, async () => {
  await using fixture = await createFixture();
  const failure = fixture.host.exec('/bin/sh', ['-c', 'echo boom >&2; exit 3']);
  await expect(failure).rejects.toThrow(/^Command failed: \/bin\/sh -c echo boom >&2; exit 3\n/);
  await expect(failure).rejects.toThrow('boom');
});

test(`${name}: lstat reports sub-second modification times`, async () => {
  await using fixture = await createFixture();
  const path = join(fixture.root, 'fresh.txt');
  await fixture.host.writeFile(path, 'x');
  const stat = await fixture.host.lstat(path);
  // A whole-second mtime would hide same-second edits from the repository watcher.
  expect(stat.mtimeMs % 1000).not.toBe(0);
});

test(`${name}: empty batches resolve without work`, async () => {
  await using fixture = await createFixture();
  expect(await fixture.host.lstatMany([])).toEqual([]);
  expect(await fixture.host.readFiles([])).toEqual([]);
});

test(`${name}: file names with shell metacharacters round-trip`, async () => {
  await using fixture = await createFixture();
  const { host, root } = fixture;
  const names = [
    `it's a "file".txt`,
    'dollar $(id) `id` $HOME.txt',
    'back\\slash \\b.txt',
    'glob *?[a].txt',
    '-leading-dash.txt',
    'ünïcødé 🙂.txt',
  ];
  for (const [index, name] of names.entries()) {
    const path = join(root, name);
    await host.writeFile(path, `content ${index}`);
    expect((await host.readFile(path)).toString('utf8')).toBe(`content ${index}`);
    expect((await host.lstat(path)).type).toBe('file');
  }
  const paths = names.map((name) => join(root, name));
  expect((await host.lstatMany(paths)).map((stat) => stat?.type)).toEqual(names.map(() => 'file'));
  expect(
    (await host.readFiles(paths)).map((value) =>
      Buffer.isBuffer(value) ? value.toString('utf8') : value,
    ),
  ).toEqual(names.map((_, index) => `content ${index}`));
  await host.rename(paths[0], join(root, `renamed 'again'.txt`));
  expect((await host.readFile(join(root, `renamed 'again'.txt`))).toString('utf8')).toBe(
    'content 0',
  );
  const output = await host.exec('/bin/sh', ['-c', 'printf "%s" "$1"', 'sh', names[1]], {
    cwd: root,
  });
  expect(output.toString('utf8')).toBe(names[1]);
});

test(`${name}: batched reads stay aligned around a newline in a file name`, async () => {
  await using fixture = await createFixture();
  const { host, root } = fixture;
  const paths = [join(root, 'before.txt'), join(root, 'line\nbreak.txt'), join(root, 'after.txt')];
  for (const [index, path] of paths.entries()) {
    await host.writeFile(path, `value ${index}\n`);
  }
  const stats = await host.lstatMany([paths[0], join(root, 'missing'), paths[1], paths[2]]);
  expect(stats.map((stat) => stat?.size ?? null)).toEqual([8, null, 8, 8]);
  const contents = await host.readFiles(paths);
  expect(
    contents.map((value) => (Buffer.isBuffer(value) ? value.toString('utf8') : 'ERR')),
  ).toEqual(['value 0\n', 'value 1\n', 'value 2\n']);
});
```

- [ ] **Step 3: Run the contract to see the new tests' state**

Run: `vp test electron/__tests__/local-host.test.ts`
Expected: the error-shape, mtime, empty-batch, metacharacter and newline tests PASS on `LocalHost`. They pin current behavior for `SshHost`; the RED phase for them is Task 8. If any of them fails on `LocalHost`, stop and report it, because that would be an existing `LocalHost` bug.

- [ ] **Step 4: Narrow the process types and document the contract**

In `electron/host/repository-host.cjs`, extend the header comment and the typedefs:

```js
/**
 * The only way repository code reaches the machine a repository lives on.
 * Implementations: `LocalHost` (this machine) and `SshHost` (a remote machine
 * over a multiplexed ssh connection). Paths passed to a host are absolute
 * paths on that host's machine.
 *
 * Contract notes:
 * - `env` options add variables on top of the host's own environment and never
 *   replace it. For `SshHost` that is the ssh session's non-interactive
 *   environment.
 * - `exec` without `input` rejects with `Command failed: <command> <args>` and
 *   the command's stderr on the next line; with `input` it rejects with the
 *   stderr (or `<command> exited with status <code>`).
 * - `lstatMany` and `readFiles` keep input order; `lstatMany` maps any
 *   per-path failure to `null`, `readFiles` to an `Error`. Empty input
 *   resolves to `[]` without contacting the host.
 * - `writeFile({exclusive: true, mode})` fails if the path exists and sets
 *   exactly `mode`. Durability (`fsync`) is not part of the contract.
 *
 * @typedef {'directory' | 'file' | 'other' | 'symlink'} HostFileType
```

Keep the existing `HostStat`, `HostExecOptions`, `HostSpawnOptions`, `HostPtyOptions` and `HostWriteFileOptions` typedefs. Add these two before `RepositoryHost`:

```js
 * @typedef {{
 *   kill: () => unknown;
 *   on: (event: string, listener: (...args: Array<any>) => void) => unknown;
 *   stderr: import('node:stream').Readable;
 *   stdin: import('node:stream').Writable;
 *   stdout: import('node:stream').Readable;
 * }} HostProcess
 * @typedef {{
 *   kill: () => void;
 *   onData: (listener: (data: string) => void) => {dispose: () => void};
 *   onExit: (listener: (event: {exitCode: number}) => void) => {dispose: () => void};
 * }} HostPty
```

Then change the two members of `RepositoryHost`:

```js
 *   spawn: (command: string, args: ReadonlyArray<string>, options?: HostSpawnOptions) => HostProcess;
 *   spawnPty: (command: string, args: ReadonlyArray<string>, options: HostPtyOptions) => HostPty;
```

In `electron/walkthrough-commit.cjs`, change `/** @type {import('node-pty').IPty} */` to `/** @type {import('./host/repository-host.cjs').HostPty} */`.

- [ ] **Step 5: Run the affected tests and the type-check gate**

Run: `vp test electron/__tests__/local-host.test.ts electron/__tests__/definition-search.test.ts electron/__tests__/walkthrough-commit.test.ts`
Expected: PASS.

Run the type-check gate described in Step 1.
Expected: no file gains errors. A node `ChildProcess` and a node-pty `IPty` both satisfy the narrowed types structurally. If `local-host.cjs` reports an assignability error on `spawnPty`, wrap the return value: `const pty = spawnPty(...); return { kill: () => pty.kill(), onData: (listener) => pty.onData(listener), onExit: (listener) => pty.onExit(listener) };`.

- [ ] **Step 6: Run the full suite, check, build and commit**

```bash
vp test
vp check --fix
vpr build
git add electron/host/repository-host.cjs electron/walkthrough-commit.cjs electron/__tests__/helpers/repository-host-contract.ts
git commit -m "Narrow host process types and pin the host contract."
```

Expected: the full suite shows exactly the 2 known baseline failures.

---

### Task 2: Best-effort commit cleanup and a launch-queue timeout

**Files:**

- Create: `electron/main/window-launch-queue.cjs`
- Create: `electron/__tests__/window-launch-queue.test.ts`
- Modify: `electron/main.cjs` (the `windowLaunchQueue` variable and `enqueueWindowLaunch` around line 1275-1286)
- Modify: `electron/walkthrough-commit.cjs` (the `finally` that removes the temp directory)
- Test: `electron/__tests__/walkthrough-commit.test.ts`

**Interfaces:**

- Consumes: `createWalkthroughCommit(host, repoPath, request, onOutput?)` and `createRecordingHost` from `core/__tests__/helpers/recording-host.ts`.
- Produces: `createWindowLaunchQueue({clearTimeoutImpl?, setTimeoutImpl?, timeoutMs?})` returning `{enqueue<T>(launch: () => Promise<T>): Promise<T>}`. The default `timeoutMs` is `15000`.

- [ ] **Step 1: Write the failing queue tests**

Create `electron/__tests__/window-launch-queue.test.ts`:

```ts
import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const { createWindowLaunchQueue } = require('../main/window-launch-queue.cjs') as {
  createWindowLaunchQueue: (options?: {
    clearTimeoutImpl?: (timer: unknown) => void;
    setTimeoutImpl?: (callback: () => void, delay: number) => unknown;
    timeoutMs?: number;
  }) => { enqueue: <T>(launch: () => Promise<T>) => Promise<T> };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('runs launches one at a time in order', async () => {
  const queue = createWindowLaunchQueue();
  const first = deferred<string>();
  const order: Array<string> = [];
  const a = queue.enqueue(async () => {
    order.push('a:start');
    const value = await first.promise;
    order.push('a:end');
    return value;
  });
  const b = queue.enqueue(async () => {
    order.push('b:start');
    return 'b';
  });
  await flush();
  expect(order).toEqual(['a:start']);
  first.resolve('a');
  expect(await a).toBe('a');
  expect(await b).toBe('b');
  expect(order).toEqual(['a:start', 'a:end', 'b:start']);
});

test('a failed launch does not block later launches', async () => {
  const queue = createWindowLaunchQueue();
  const a = queue.enqueue(async () => {
    throw new Error('broken');
  });
  const b = queue.enqueue(async () => 'b');
  await expect(a).rejects.toThrow('broken');
  expect(await b).toBe('b');
});

test('a hung launch stops blocking the queue after the timeout', async () => {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const queue = createWindowLaunchQueue({
    clearTimeoutImpl: () => {},
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    timeoutMs: 15_000,
  });
  void queue.enqueue(() => new Promise<never>(() => {}));
  let secondStarted = false;
  const second = queue.enqueue(async () => {
    secondStarted = true;
    return 'second';
  });
  await flush();
  expect(secondStarted).toBe(false);
  expect(timers.map(({ delay }) => delay)).toEqual([15_000]);
  timers[0].callback();
  expect(await second).toBe('second');
});
```

- [ ] **Step 2: Write the failing cleanup test**

Add to `electron/__tests__/walkthrough-commit.test.ts`, reusing its `withRepo`, `git`, `writeFile`, `join` and `host` setup:

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `vp test electron/__tests__/window-launch-queue.test.ts electron/__tests__/walkthrough-commit.test.ts`
Expected: the queue tests FAIL with `Cannot find module '../main/window-launch-queue.cjs'`. The cleanup test FAILS with `status` equal to `'failed'`.

- [ ] **Step 4: Implement the queue**

Create `electron/main/window-launch-queue.cjs`:

```js
// @ts-check

/**
 * Runs window launches one at a time, so each launch sees the windows that
 * earlier launches created. A launch that hangs (for example on an unreachable
 * repository host) stops blocking later launches after `timeoutMs`; it keeps
 * running in the background.
 *
 * @param {{
 *   clearTimeoutImpl?: (timer: any) => void;
 *   setTimeoutImpl?: (callback: () => void, delay: number) => any;
 *   timeoutMs?: number;
 * }} [options]
 */
const createWindowLaunchQueue = ({
  clearTimeoutImpl = clearTimeout,
  setTimeoutImpl = setTimeout,
  timeoutMs = 15_000,
} = {}) => {
  /** @type {Promise<void>} */
  let tail = Promise.resolve();
  return {
    /**
     * @template T
     * @param {() => Promise<T>} launch
     * @returns {Promise<T>}
     */
    enqueue: (launch) => {
      const result = tail.then(launch);
      tail = tail.then(
        () =>
          new Promise((resolve) => {
            const timer = setTimeoutImpl(resolve, timeoutMs);
            timer?.unref?.();
            const release = () => {
              clearTimeoutImpl(timer);
              resolve(undefined);
            };
            result.then(release, release);
          }),
      );
      return result;
    },
  };
};

module.exports = { createWindowLaunchQueue };
```

- [ ] **Step 5: Use the queue in `main.cjs`**

Replace the `windowLaunchQueue` variable and the body of `enqueueWindowLaunch` (keep its JSDoc and name) with:

```js
const windowLaunchQueue = createWindowLaunchQueue();

/**
 * @template T
 * @param {() => Promise<T>} launch
 * @returns {Promise<T>}
 */
const enqueueWindowLaunch = (launch) => windowLaunchQueue.enqueue(launch);
```

Add `const { createWindowLaunchQueue } = require('./main/window-launch-queue.cjs');` next to the other `./main/` requires.

- [ ] **Step 6: Make the commit cleanup best-effort**

In `electron/walkthrough-commit.cjs`, change the `finally` block to:

```js
    } finally {
      // Cleanup is best-effort: a leftover temp directory must not turn a
      // commit that already happened into a reported failure.
      await host.rm(tempDirectory, { force: true, recursive: true }).catch(() => {});
    }
```

- [ ] **Step 7: Run the tests, the gate, the suite, then check, build and commit**

```bash
vp test electron/__tests__/window-launch-queue.test.ts electron/__tests__/walkthrough-commit.test.ts
vp test
vp check --fix
vpr build
git add electron/main/window-launch-queue.cjs electron/__tests__/window-launch-queue.test.ts electron/main.cjs electron/walkthrough-commit.cjs electron/__tests__/walkthrough-commit.test.ts
git commit -m "Time out hung window launches and make commit cleanup best-effort."
```

Expected: the targeted tests PASS, the full suite shows exactly the 2 known baseline failures, and the type-check gate passes.

---

### Task 3: Shell quoting

**Files:**

- Create: `electron/host/shell-quote.cjs`
- Create: `electron/__tests__/shell-quote.test.ts`

**Interfaces:**

- Produces:
  - `PID_MARKER: '__codiff_pid__:'`
  - `quotePosix(value: string): string`
  - `quoteFish(value: string): string`
  - `getShellDialect(shellPath: string): 'fish' | 'posix' | null`
  - `buildCommandScript({announcePid?, args?, command, cwd?, env?}): string`
  - `wrapForLoginShell(script: string, dialect: 'fish' | 'posix'): string`
  - typedef `ShellDialect`

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/shell-quote.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

type ShellDialect = 'fish' | 'posix';

const require = createRequire(import.meta.url);
const { PID_MARKER, buildCommandScript, getShellDialect, quotePosix, wrapForLoginShell } =
  require('../host/shell-quote.cjs') as {
    PID_MARKER: string;
    buildCommandScript: (options: {
      announcePid?: boolean;
      args?: ReadonlyArray<string>;
      command: string;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }) => string;
    getShellDialect: (shellPath: string) => ShellDialect | null;
    quotePosix: (value: string) => string;
    wrapForLoginShell: (script: string, dialect: ShellDialect) => string;
  };

const execFileAsync = promisify(execFile);

const findShell = (name: string) =>
  ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
    .map((directory) => `${directory}/${name}`)
    .find((path) => existsSync(path)) ?? null;

const shells = (['sh', 'bash', 'zsh', 'dash', 'fish'] as const).map((name) => ({
  dialect: (name === 'fish' ? 'fish' : 'posix') as ShellDialect,
  name,
  path: findShell(name),
}));

const dangerousValues = [
  '',
  'plain',
  'with space',
  "it's",
  "''",
  "'",
  'say "hi"',
  'back\\slash',
  '\\',
  "\\'",
  '\\b\\w+',
  '$HOME',
  '${HOME}',
  '`id`',
  '$(id)',
  '*',
  '?',
  '[a]',
  '~',
  '~/x',
  '!',
  '!!',
  '#comment',
  'line\nbreak',
  'tab\there',
  '-n',
  '--',
  ';',
  '&&',
  '|',
  '>',
  '%s',
  ' leading',
  'trailing ',
  'ünïcødé 🙂',
];

// Deterministic pseudo-random strings (mulberry32) over a hostile alphabet.
const randomValues = (count: number) => {
  let seed = 0x5eed;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = [...' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~\n\tabcXYZ019ü🙂'];
  return Array.from({ length: count }, () =>
    Array.from(
      { length: Math.floor(next() * 12) },
      () => alphabet[Math.floor(next() * alphabet.length)],
    ).join(''),
  );
};

const roundTrip = async (
  shellPath: string,
  dialect: ShellDialect,
  values: ReadonlyArray<string>,
) => {
  const script = buildCommandScript({ args: ['%s\\0', ...values], command: 'printf' });
  const { stdout } = await execFileAsync(shellPath, ['-c', wrapForLoginShell(script, dialect)], {
    encoding: 'buffer',
  });
  return stdout.toString('utf8').split('\0').slice(0, -1);
};

for (const shell of shells) {
  describe.skipIf(!shell.path)(`${shell.name} login shell`, () => {
    test('passes hostile arguments through byte for byte', async () => {
      expect(await roundTrip(shell.path!, shell.dialect, dangerousValues)).toEqual(dangerousValues);
    });

    test('passes random arguments through byte for byte', async () => {
      const values = randomValues(300);
      expect(await roundTrip(shell.path!, shell.dialect, values)).toEqual(values);
    });

    test('applies cwd and env exactly', async () => {
      await using directory = await createTemporaryDirectory("codiff quote 'dir' ");
      const script = buildCommandScript({
        args: ['-c', 'pwd -P; printf "%s" "$CODIFF_QUOTE"'],
        command: '/bin/sh',
        cwd: directory.path,
        env: { CODIFF_QUOTE: `a'b "c" $d \\e` },
      });
      const { stdout } = await execFileAsync(shell.path!, [
        '-c',
        wrapForLoginShell(script, shell.dialect),
      ]);
      const [cwd, value] = stdout.split('\n');
      expect(cwd.endsWith(directory.path.split('/').pop()!)).toBe(true);
      expect(value).toBe(`a'b "c" $d \\e`);
    });

    test('announces the PID of the command it executes', async () => {
      const script = buildCommandScript({
        announcePid: true,
        args: ['-c', 'echo "$$"'],
        command: '/bin/sh',
      });
      const { stderr, stdout } = await execFileAsync(shell.path!, [
        '-c',
        wrapForLoginShell(script, shell.dialect),
      ]);
      expect(stderr).toBe(`${PID_MARKER}${stdout.trim()}\n`);
    });
  });
}

test('getShellDialect recognizes supported login shells', () => {
  expect(getShellDialect('/bin/sh')).toBe('posix');
  expect(getShellDialect('/usr/bin/bash')).toBe('posix');
  expect(getShellDialect('/bin/zsh')).toBe('posix');
  expect(getShellDialect('/bin/dash')).toBe('posix');
  expect(getShellDialect('/bin/ksh')).toBe('posix');
  expect(getShellDialect('/opt/homebrew/bin/fish\n')).toBe('fish');
  expect(getShellDialect('/bin/tcsh')).toBeNull();
  expect(getShellDialect('/bin/csh')).toBeNull();
  expect(getShellDialect('/usr/bin/nu')).toBeNull();
  expect(getShellDialect('')).toBeNull();
});

test('quoting rejects NUL bytes', () => {
  expect(() => quotePosix('a\0b')).toThrow('Shell arguments cannot contain NUL bytes.');
  expect(() => buildCommandScript({ args: ['a\0b'], command: 'printf' })).toThrow('NUL');
});

test('env names must be valid identifiers', () => {
  expect(() => buildCommandScript({ command: 'true', env: { 'A=B': 'x' } })).toThrow(
    'Invalid environment variable name: A=B',
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test electron/__tests__/shell-quote.test.ts`
Expected: FAIL with `Cannot find module '../host/shell-quote.cjs'`.

- [ ] **Step 3: Implement the module**

Create `electron/host/shell-quote.cjs`:

```js
// @ts-check

/**
 * Remote commands reach the remote login shell as one string. Codiff sends a
 * fixed wrapper, `exec /bin/sh -c <script>`, quoted for that shell's dialect,
 * and the script itself is POSIX `sh` with every argument single-quoted.
 *
 * @typedef {'fish' | 'posix'} ShellDialect
 */

const PID_MARKER = '__codiff_pid__:';
const POSIX_SHELLS = new Set(['ash', 'bash', 'dash', 'ksh', 'mksh', 'sh', 'zsh']);
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @param {string} value */
const assertNoNul = (value) => {
  if (value.includes('\0')) {
    throw new Error('Shell arguments cannot contain NUL bytes.');
  }
};

/** @param {string} value */
const quotePosix = (value) => {
  assertNoNul(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
};

/**
 * fish treats `\\` and `\'` as escapes inside single quotes.
 *
 * @param {string} value
 */
const quoteFish = (value) => {
  assertNoNul(value);
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
};

/** @param {string} shellPath @returns {ShellDialect | null} */
const getShellDialect = (shellPath) => {
  const name = shellPath.trim().split('/').pop() ?? '';
  return name === 'fish' ? 'fish' : POSIX_SHELLS.has(name) ? 'posix' : null;
};

/**
 * Builds a POSIX `sh` script that runs one command with exactly the given
 * argv. With `announcePid`, the script first prints `PID_MARKER<pid>` on
 * stderr; the command then replaces the shell, so it keeps that PID.
 *
 * @param {{
 *   announcePid?: boolean;
 *   args?: ReadonlyArray<string>;
 *   command: string;
 *   cwd?: string;
 *   env?: Readonly<Record<string, string>>;
 * }} options
 */
const buildCommandScript = ({ announcePid = false, args = [], command, cwd, env = {} }) => {
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    return quotePosix(`${name}=${value}`);
  });
  const invocation = [
    'exec',
    ...(assignments.length > 0 ? ['env', ...assignments] : []),
    ...[command, ...args].map(quotePosix),
  ].join(' ');
  return [
    ...(cwd ? [`cd ${quotePosix(cwd)}`] : []),
    ...(announcePid ? [`printf '${PID_MARKER}%s\\n' "$$" >&2`] : []),
    invocation,
  ].join(' && ');
};

/** @param {string} script @param {ShellDialect} dialect */
const wrapForLoginShell = (script, dialect) =>
  `exec /bin/sh -c ${dialect === 'fish' ? quoteFish(script) : quotePosix(script)}`;

module.exports = {
  PID_MARKER,
  buildCommandScript,
  getShellDialect,
  quoteFish,
  quotePosix,
  wrapForLoginShell,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test electron/__tests__/shell-quote.test.ts`
Expected: PASS for every shell installed here. This Mac has `sh`, `bash`, `zsh`, `dash` and `fish`; any missing shell's block is skipped.

- [ ] **Step 5: Gate, check, build and commit**

Run the type-check gate, then:

```bash
vp check --fix
vpr build
git add electron/host/shell-quote.cjs electron/__tests__/shell-quote.test.ts
git commit -m "Add shell quoting for remote repository commands."
```

---

### Task 4: Typed host errors

**Files:**

- Create: `electron/host/host-errors.cjs`
- Create: `electron/__tests__/host-errors.test.ts`

**Interfaces:**

- Produces these classes, each extending `Error` with `name` set to the class name and an `alias` property:
  - `HostAuthRequiredError(alias)`
  - `HostUnreachableError(alias, detail)`
  - `HostDisconnectedError(alias, detail?)`
  - `UnsupportedRemoteShellError(alias, shell)`
  - `RemoteCommandMissingError(alias, command)`
  - `RemoteShellNoiseError(alias)`
- Also produces `classifySshFailure(alias: string, stderr: string, options?: {connected?: boolean}): Error`.

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/host-errors.test.ts`:

```ts
import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const errors = require('../host/host-errors.cjs') as {
  HostAuthRequiredError: new (alias: string) => Error & { alias: string };
  HostDisconnectedError: new (
    alias: string,
    detail?: string,
  ) => Error & { alias: string; detail: string };
  HostUnreachableError: new (alias: string, detail: string) => Error & { alias: string };
  RemoteCommandMissingError: new (alias: string, command: string) => Error & { command: string };
  RemoteShellNoiseError: new (alias: string) => Error;
  UnsupportedRemoteShellError: new (alias: string, shell: string) => Error & { shell: string };
  classifySshFailure: (alias: string, stderr: string, options?: { connected?: boolean }) => Error;
};

test('host errors carry the spec messages and names', () => {
  expect(new errors.HostAuthRequiredError('devbox')).toMatchObject({
    alias: 'devbox',
    message: 'devbox needs interactive login. Run `codiff devbox:<path>` from a terminal.',
    name: 'HostAuthRequiredError',
  });
  expect(
    new errors.HostUnreachableError(
      'devbox',
      'ssh: connect to host devbox port 22: Connection refused',
    ),
  ).toMatchObject({
    message: 'ssh: connect to host devbox port 22: Connection refused',
    name: 'HostUnreachableError',
  });
  expect(new errors.HostUnreachableError('devbox', '').message).toBe('Could not reach devbox.');
  expect(new errors.HostDisconnectedError('devbox', 'broken pipe')).toMatchObject({
    detail: 'broken pipe',
    message: 'Lost connection to devbox.',
    name: 'HostDisconnectedError',
  });
  expect(new errors.UnsupportedRemoteShellError('devbox', '/bin/tcsh')).toMatchObject({
    message: 'Codiff needs a POSIX or fish login shell on devbox.',
    name: 'UnsupportedRemoteShellError',
    shell: '/bin/tcsh',
  });
  expect(new errors.RemoteCommandMissingError('devbox', 'git')).toMatchObject({
    command: 'git',
    message: "git isn't installed on devbox.",
    name: 'RemoteCommandMissingError',
  });
  expect(new errors.RemoteShellNoiseError('devbox').message).toBe(
    "devbox's shell startup files print output in non-interactive sessions, which breaks Codiff. Only print output in interactive shells.",
  );
});

test('authentication failures need an interactive login in every phase', () => {
  for (const stderr of [
    'vivek@devbox: Permission denied (publickey).',
    'Host key verification failed.',
    'Received disconnect from 10.0.0.2 port 22:2: Too many authentication failures',
    'Permission denied (publickey,keyboard-interactive).',
  ]) {
    expect(errors.classifySshFailure('devbox', stderr, { connected: false }).name).toBe(
      'HostAuthRequiredError',
    );
    expect(errors.classifySshFailure('devbox', stderr).name).toBe('HostAuthRequiredError');
  }
});

test('other failures are unreachable while connecting and disconnected afterwards', () => {
  const stderr =
    'ssh: Could not resolve hostname devbox: nodename nor servname provided, or not known\n';
  const connecting = errors.classifySshFailure('devbox', stderr, { connected: false });
  expect(connecting.name).toBe('HostUnreachableError');
  expect(connecting.message).toBe(stderr.trim());
  const session = errors.classifySshFailure('devbox', 'client_loop: send disconnect: Broken pipe');
  expect(session.name).toBe('HostDisconnectedError');
  expect(session.message).toBe('Lost connection to devbox.');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test electron/__tests__/host-errors.test.ts`
Expected: FAIL with `Cannot find module '../host/host-errors.cjs'`.

- [ ] **Step 3: Implement the module**

Create `electron/host/host-errors.cjs`:

```js
// @ts-check

class HostAuthRequiredError extends Error {
  /** @param {string} alias */
  constructor(alias) {
    super(`${alias} needs interactive login. Run \`codiff ${alias}:<path>\` from a terminal.`);
    this.name = 'HostAuthRequiredError';
    this.alias = alias;
  }
}

class HostUnreachableError extends Error {
  /** @param {string} alias @param {string} detail */
  constructor(alias, detail) {
    super(detail.trim() || `Could not reach ${alias}.`);
    this.name = 'HostUnreachableError';
    this.alias = alias;
  }
}

class HostDisconnectedError extends Error {
  /** @param {string} alias @param {string} [detail] */
  constructor(alias, detail = '') {
    super(`Lost connection to ${alias}.`);
    this.name = 'HostDisconnectedError';
    this.alias = alias;
    this.detail = detail.trim();
  }
}

class UnsupportedRemoteShellError extends Error {
  /** @param {string} alias @param {string} shell */
  constructor(alias, shell) {
    super(`Codiff needs a POSIX or fish login shell on ${alias}.`);
    this.name = 'UnsupportedRemoteShellError';
    this.alias = alias;
    this.shell = shell;
  }
}

class RemoteCommandMissingError extends Error {
  /** @param {string} alias @param {string} command */
  constructor(alias, command) {
    super(`${command} isn't installed on ${alias}.`);
    this.name = 'RemoteCommandMissingError';
    this.alias = alias;
    this.command = command;
  }
}

class RemoteShellNoiseError extends Error {
  /** @param {string} alias */
  constructor(alias) {
    super(
      `${alias}'s shell startup files print output in non-interactive sessions, which breaks Codiff. Only print output in interactive shells.`,
    );
    this.name = 'RemoteShellNoiseError';
    this.alias = alias;
  }
}

const AUTH_PATTERNS = [
  /permission denied/i,
  /host key verification failed/i,
  /too many authentication failures/i,
  /no more authentication methods/i,
];

/**
 * While connecting, any non-authentication failure means the host could not be
 * reached; once connected, it means the connection was lost.
 *
 * @param {string} alias
 * @param {string} stderr
 * @param {{connected?: boolean}} [options]
 * @returns {Error}
 */
const classifySshFailure = (alias, stderr, { connected = true } = {}) =>
  AUTH_PATTERNS.some((pattern) => pattern.test(stderr))
    ? new HostAuthRequiredError(alias)
    : connected
      ? new HostDisconnectedError(alias, stderr)
      : new HostUnreachableError(alias, stderr);

module.exports = {
  HostAuthRequiredError,
  HostDisconnectedError,
  HostUnreachableError,
  RemoteCommandMissingError,
  RemoteShellNoiseError,
  UnsupportedRemoteShellError,
  classifySshFailure,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test electron/__tests__/host-errors.test.ts`
Expected: PASS. Then run the type-check gate. If tsc reports that a class property such as `alias` is not declared, add a JSDoc `/** @type {string} */` line above the assignment.

- [ ] **Step 5: Check, build and commit**

```bash
vp check --fix
vpr build
git add electron/host/host-errors.cjs electron/__tests__/host-errors.test.ts
git commit -m "Add typed errors for repository hosts."
```

---

### Task 5: Test `sshd` harness and CI

**Files:**

- Create: `electron/__tests__/helpers/test-sshd.ts`
- Create: `electron/__tests__/test-sshd.test.ts`
- Modify: `.github/workflows/test.yml`

**Interfaces:**

- Produces:
  - `findSshd(): string | null`
  - `startTestSshd(options?: {authorize?: boolean}): Promise<TestSshd>`, where `TestSshd = {alias: 'codiff-test'; controlDirectory: string; getLog(): string; port: number; root: string; sshConfigPath: string; stop(): Promise<void>; unreachableAlias: 'codiff-unreachable'; [Symbol.asyncDispose](): Promise<void>}`
  - The ssh config sends `GIT_*` and `CODIFF_*` (`SendEnv`), and the server accepts them (`AcceptEnv`), so suites that set Git variables on the test process behave the same over SSH.

- [ ] **Step 1: Write the harness self-test**

Create `electron/__tests__/test-sshd.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

const execFileAsync = promisify(execFile);

describe.skipIf(!findSshd())('test sshd', () => {
  test('accepts the generated key and forwards Git variables', async () => {
    await using sshd = await startTestSshd();
    const { stdout } = await execFileAsync(
      'ssh',
      [
        '-F',
        sshd.sshConfigPath,
        '-o',
        'BatchMode=yes',
        sshd.alias,
        'echo ok; echo "$GIT_CODIFF_HARNESS"',
      ],
      { env: { ...process.env, GIT_CODIFF_HARNESS: 'forwarded' } },
    );
    expect(stdout).toBe('ok\nforwarded\n');
  });

  test('rejects an unauthorized key', async () => {
    await using sshd = await startTestSshd({ authorize: false });
    await expect(
      execFileAsync('ssh', ['-F', sshd.sshConfigPath, '-o', 'BatchMode=yes', sshd.alias, 'true']),
    ).rejects.toThrow(/Permission denied/);
  });

  test('provides an alias for a port nothing listens on', async () => {
    await using sshd = await startTestSshd();
    await expect(
      execFileAsync('ssh', [
        '-F',
        sshd.sshConfigPath,
        '-o',
        'BatchMode=yes',
        sshd.unreachableAlias,
        'true',
      ]),
    ).rejects.toThrow(/Connection refused/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test electron/__tests__/test-sshd.test.ts`
Expected: FAIL with `Cannot find module './helpers/test-sshd.ts'`.

- [ ] **Step 3: Implement the harness**

Create `electron/__tests__/helpers/test-sshd.ts`:

```ts
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type TestSshd = {
  alias: 'codiff-test';
  controlDirectory: string;
  getLog: () => string;
  port: number;
  root: string;
  sshConfigPath: string;
  stop: () => Promise<void>;
  unreachableAlias: 'codiff-unreachable';
  [Symbol.asyncDispose]: () => Promise<void>;
};

export const findSshd = () =>
  ['/usr/sbin/sshd', '/usr/bin/sshd', '/opt/homebrew/sbin/sshd'].find((path) => existsSync(path)) ??
  null;

const getFreePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

const waitForPort = async (port: number, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Test sshd did not start on port ${port}.`);
};

const generateKey = (path: string) =>
  execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'codiff-test', '-f', path]);

/**
 * Starts a non-root sshd on 127.0.0.1 that accepts one generated key for the
 * current user. The root lives under /tmp so `<root>/cm/%C` stays below the
 * 104-byte Unix socket path limit on macOS.
 */
export const startTestSshd = async ({
  authorize = true,
}: { authorize?: boolean } = {}): Promise<TestSshd> => {
  const sshd = findSshd();
  if (!sshd) {
    throw new Error('sshd is not installed. Install openssh-server to run SSH host tests.');
  }
  const root = await mkdtemp('/tmp/cdf-');
  await Promise.all([
    generateKey(join(root, 'host_key')),
    generateKey(join(root, 'client_key')),
    generateKey(join(root, 'other_key')),
  ]);
  const authorizedKey = await readFile(
    join(root, authorize ? 'client_key.pub' : 'other_key.pub'),
    'utf8',
  );
  await writeFile(join(root, 'authorized_keys'), authorizedKey, { mode: 0o600 });
  const [port, unreachablePort] = await Promise.all([getFreePort(), getFreePort()]);
  await writeFile(
    join(root, 'sshd_config'),
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${join(root, 'host_key')}`,
      `AuthorizedKeysFile ${join(root, 'authorized_keys')}`,
      `PidFile ${join(root, 'sshd.pid')}`,
      'UsePAM no',
      'StrictModes no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'AcceptEnv GIT_* CODIFF_*',
      '',
    ].join('\n'),
  );
  const user = userInfo().username;
  const clientOptions = [
    `  User ${user}`,
    `  IdentityFile ${join(root, 'client_key')}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking no',
    `  UserKnownHostsFile ${join(root, 'known_hosts')}`,
    '  SendEnv GIT_* CODIFF_*',
  ];
  const sshConfigPath = join(root, 'ssh_config');
  await writeFile(
    sshConfigPath,
    [
      'Host codiff-test',
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      ...clientOptions,
      'Host codiff-unreachable',
      '  HostName 127.0.0.1',
      `  Port ${unreachablePort}`,
      ...clientOptions,
      '',
    ].join('\n'),
  );

  const server = spawn(sshd, ['-D', '-e', '-f', join(root, 'sshd_config')], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  server.stderr.on('data', (chunk: Buffer) => {
    log += chunk.toString('utf8');
  });
  try {
    await waitForPort(port);
  } catch (error) {
    server.kill();
    throw new Error(`${(error as Error).message}\n${log}`);
  }

  const controlDirectory = join(root, 'cm');
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    await execFileAsync('ssh', [
      '-F',
      sshConfigPath,
      '-o',
      `ControlPath=${join(controlDirectory, '%C')}`,
      '-O',
      'exit',
      'codiff-test',
    ]).catch(() => {});
    if (server.exitCode == null) {
      server.kill();
      await once(server, 'exit');
    }
    await rm(root, { force: true, recursive: true });
  };

  return {
    alias: 'codiff-test',
    controlDirectory,
    getLog: () => log,
    port,
    root,
    sshConfigPath,
    stop,
    unreachableAlias: 'codiff-unreachable',
    [Symbol.asyncDispose]: stop,
  };
};
```

- [ ] **Step 4: Run the harness test**

Run: `vp test electron/__tests__/test-sshd.test.ts`
Expected: PASS (3 tests). While planning, this exact non-root setup was verified on this Mac (`/usr/sbin/sshd`, OpenSSH 9.9). If the first test fails, include `sshd.getLog()` output in your report.

- [ ] **Step 5: Install SSH test dependencies in CI**

In `.github/workflows/test.yml`, change the `Install native-keymap dependencies` step to:

```yaml
- name: Install native and SSH test dependencies
  run: |
    sudo apt-get update
    sudo apt-get install --yes libx11-dev libxkbfile-dev openssh-server zsh fish
    # sshd refuses to start without its privilege separation directory.
    sudo mkdir -p /run/sshd
```

- [ ] **Step 6: Gate, suite, check, build and commit**

Run the type-check gate and the full `vp test` (expect exactly the 2 known baseline failures), then:

```bash
vp check --fix
vpr build
git add electron/__tests__/helpers/test-sshd.ts electron/__tests__/test-sshd.test.ts .github/workflows/test.yml
git commit -m "Add a throwaway sshd for SSH host tests."
```

---

### Task 6: SSH connection and master lifecycle

**Files:**

- Create: `electron/host/ssh-connection.cjs`
- Create: `electron/__tests__/ssh-connection.test.ts`

**Interfaces:**

- Consumes: `classifySshFailure` (Task 4) and `startTestSshd` (Task 5).
- Produces:
  - `createSshConnection(options: SshConnectionOptions): SshConnection`
  - `SshConnectionOptions = {alias: string; controlDirectory?: string; getLocalEnvironment?: () => NodeJS.ProcessEnv; spawnProcess?: typeof spawn; sshCommand?: string; sshConfigPath?: string}`
  - `SshConnection = {alias: string; check(): Promise<boolean>; ensureMaster(): Promise<void>; exitMaster(): Promise<void>; run(remoteCommand: string, options?: {input?: string | Buffer}): Promise<SshResult>; spawnClient(remoteCommand: string, options?: {tty?: boolean}): ChildProcessWithoutNullStreams; startMaster(): Promise<void>}`
  - `SshResult = {code: number | null; stderr: string; stdout: Buffer}`

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/ssh-connection.test.ts`:

```ts
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vite-plus/test';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

type SshResult = { code: number | null; stderr: string; stdout: Buffer };
type SshConnection = {
  alias: string;
  check: () => Promise<boolean>;
  ensureMaster: () => Promise<void>;
  exitMaster: () => Promise<void>;
  run: (remoteCommand: string, options?: { input?: string | Buffer }) => Promise<SshResult>;
  startMaster: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const { createSshConnection } = require('../host/ssh-connection.cjs') as {
  createSshConnection: (options: {
    alias: string;
    controlDirectory?: string;
    sshConfigPath?: string;
  }) => SshConnection;
};

test('rejects destinations that ssh would parse as options', () => {
  expect(() =>
    createSshConnection({ alias: '-oProxyCommand=evil', controlDirectory: '/tmp' }),
  ).toThrow('Invalid SSH host: -oProxyCommand=evil');
  expect(() => createSshConnection({ alias: 'host:path', controlDirectory: '/tmp' })).toThrow();
});

describe.skipIf(!findSshd())('ssh connection', () => {
  test('starts, checks, uses and exits a master connection', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    expect(await connection.check()).toBe(false);
    await connection.startMaster();
    expect(await connection.check()).toBe(true);

    const result = await connection.run('cat; echo " $$"', { input: 'hello' });
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toMatch(/^hello \d+\n$/);

    const exitCode = await connection.run('exit 7');
    expect(exitCode.code).toBe(7);

    await connection.exitMaster();
    expect(await connection.check()).toBe(false);
  });

  test('ensureMaster starts a master once for concurrent callers', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await Promise.all([
      connection.ensureMaster(),
      connection.ensureMaster(),
      connection.ensureMaster(),
    ]);
    expect(await connection.check()).toBe(true);
    await connection.exitMaster();
  });

  test('a failed master start reports an authentication problem', async () => {
    await using sshd = await startTestSshd({ authorize: false });
    const connection = createSshConnection({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await expect(connection.startMaster()).rejects.toMatchObject({ name: 'HostAuthRequiredError' });
  });

  test('a failed master start reports an unreachable host', async () => {
    await using sshd = await startTestSshd();
    const connection = createSshConnection({
      alias: sshd.unreachableAlias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await expect(connection.startMaster()).rejects.toMatchObject({
      message: expect.stringMatching(/Connection refused/),
      name: 'HostUnreachableError',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test electron/__tests__/ssh-connection.test.ts`
Expected: FAIL with `Cannot find module '../host/ssh-connection.cjs'`.

- [ ] **Step 3: Implement the module**

Create `electron/host/ssh-connection.cjs`:

```js
// @ts-check

const { spawn } = require('node:child_process');
const { mkdirSync, readFileSync, rmSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { classifySshFailure } = require('./host-errors.cjs');

/**
 * @typedef {{
 *   alias: string;
 *   controlDirectory?: string;
 *   getLocalEnvironment?: () => NodeJS.ProcessEnv;
 *   spawnProcess?: typeof spawn;
 *   sshCommand?: string;
 *   sshConfigPath?: string;
 * }} SshConnectionOptions
 * @typedef {{code: number | null; stderr: string; stdout: Buffer}} SshResult
 * @typedef {ReturnType<typeof createSshConnection>} SshConnection
 */

// A destination exactly as typed after `ssh`: an alias from ~/.ssh/config or
// user@host. A leading `-` would be parsed as an option.
const ALIAS_PATTERN = /^(?!-)[\w.@%+-]+$/;

const getDefaultControlDirectory = () => join(homedir(), '.codiff', 'ssh');

/**
 * One multiplexed connection to an ssh destination. The master runs in the
 * background (`ControlPersist=yes`); every other invocation is a client with
 * `ControlMaster=auto`, so if the master is gone a client connects on its own
 * instead of failing. `BatchMode=yes` keeps every invocation from prompting.
 *
 * @param {SshConnectionOptions} options
 */
const createSshConnection = ({
  alias,
  controlDirectory = getDefaultControlDirectory(),
  getLocalEnvironment = () => process.env,
  spawnProcess = spawn,
  sshCommand = 'ssh',
  sshConfigPath,
}) => {
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error(`Invalid SSH host: ${alias}`);
  }
  mkdirSync(controlDirectory, { mode: 0o700, recursive: true });
  const masterLogPath = join(controlDirectory, `${alias}.log`);
  const baseArgs = [
    ...(sshConfigPath ? ['-F', sshConfigPath] : []),
    '-o',
    `ControlPath=${join(controlDirectory, '%C')}`,
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'BatchMode=yes',
    '-o',
    'LogLevel=ERROR',
  ];
  const clientArgs = [...baseArgs, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=no'];

  /**
   * @param {ReadonlyArray<string>} args
   * @param {{input?: string | Buffer}} [options]
   * @returns {Promise<SshResult>}
   */
  const runSsh = (args, { input } = {}) =>
    new Promise((resolve) => {
      const child = spawnProcess(sshCommand, [...args], {
        env: getLocalEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      /** @type {Array<Buffer>} */
      const stdout = [];
      /** @type {Array<Buffer>} */
      const stderr = [];
      let done = false;
      /** @param {number | null} code */
      const finish = (code) => {
        if (!done) {
          done = true;
          resolve({
            code,
            stderr: Buffer.concat(stderr).toString('utf8'),
            stdout: Buffer.concat(stdout),
          });
        }
      };
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.stdin.on('error', () => {});
      child.on('error', (error) => {
        stderr.push(Buffer.from(error.message));
        finish(null);
      });
      child.on('close', finish);
      child.stdin.end(input);
    });

  const check = async () => (await runSsh([...baseArgs, '-O', 'check', alias])).code === 0;

  const readMasterLog = () => {
    try {
      return readFileSync(masterLogPath, 'utf8');
    } catch {
      return '';
    }
  };

  // `ssh -f` forks a master that keeps any inherited output pipes open, so the
  // master gets no pipes and writes its errors to a log file (`-E`) instead.
  const startMaster = async () => {
    rmSync(masterLogPath, { force: true });
    /** @type {number | null} */
    const code = await new Promise((resolve) => {
      const child = spawnProcess(
        sshCommand,
        [
          ...baseArgs,
          '-E',
          masterLogPath,
          '-o',
          'ControlMaster=yes',
          '-o',
          'ControlPersist=yes',
          '-f',
          '-N',
          alias,
        ],
        { env: getLocalEnvironment(), stdio: 'ignore' },
      );
      child.on('error', () => resolve(null));
      child.on('exit', resolve);
    });
    if (code !== 0) {
      throw classifySshFailure(alias, readMasterLog(), { connected: false });
    }
  };

  /** @type {Promise<void> | null} */
  let pendingMaster = null;
  const ensureMaster = () => {
    pendingMaster ??= (async () => {
      try {
        if (!(await check())) {
          await startMaster();
        }
      } finally {
        pendingMaster = null;
      }
    })();
    return pendingMaster;
  };

  const exitMaster = async () => {
    await runSsh([...baseArgs, '-O', 'exit', alias]);
  };

  /** @param {string} remoteCommand @param {{input?: string | Buffer}} [options] */
  const run = (remoteCommand, options) =>
    runSsh([...clientArgs, '-T', alias, remoteCommand], options);

  /** @param {string} remoteCommand @param {{tty?: boolean}} [options] */
  const spawnClient = (remoteCommand, { tty = false } = {}) =>
    spawnProcess(sshCommand, [...clientArgs, tty ? '-tt' : '-T', alias, remoteCommand], {
      env: getLocalEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

  return { alias, check, ensureMaster, exitMaster, run, spawnClient, startMaster };
};

module.exports = { createSshConnection, getDefaultControlDirectory };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test electron/__tests__/ssh-connection.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate, check, build and commit**

Run the type-check gate, then:

```bash
vp check --fix
vpr build
git add electron/host/ssh-connection.cjs electron/__tests__/ssh-connection.test.ts
git commit -m "Add a multiplexed SSH connection with a background master."
```

---

### Task 7: `SshHost` connect, commands and cancellation

**Files:**

- Create: `electron/host/ssh-host.cjs`
- Create: `electron/__tests__/ssh-host.test.ts`

**Interfaces:**

- Consumes: `createSshConnection`/`SshConnection` (Task 6); `PID_MARKER`, `buildCommandScript`, `getShellDialect`, `quotePosix` and `wrapForLoginShell` (Task 3); the host errors (Task 4); and `HostProcess`/`HostPty` (Task 1).
- Produces:
  - `connectSshHost(options: SshConnectionOptions & {connection?: SshConnection; masterCheckIntervalMs?: number}): Promise<SshHost>`, where `SshHost = RepositoryHost & {close(): Promise<void>}`, `id` is `ssh://<alias>` and `label` is the alias.
  - `createPidMarkerFilter(onPid: (pid: number) => void): Transform`, exported for tests.
  - In this task, `exec`, `spawn`, `spawnPty` and `close` are implemented. The file methods throw `new Error('Not implemented yet.')` until Task 8.

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/ssh-host.test.ts`:

```ts
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';
import type { RepositoryHost } from '../host/repository-host.cjs';
import { findSshd, startTestSshd, type TestSshd } from './helpers/test-sshd.ts';

type SshHost = RepositoryHost & { close: () => Promise<void> };

const require = createRequire(import.meta.url);
const { connectSshHost, createPidMarkerFilter } = require('../host/ssh-host.cjs') as {
  connectSshHost: (options: {
    alias: string;
    controlDirectory?: string;
    masterCheckIntervalMs?: number;
    sshConfigPath?: string;
  }) => Promise<SshHost>;
  createPidMarkerFilter: (onPid: (pid: number) => void) => import('node:stream').Transform;
};

const connect = (sshd: TestSshd) =>
  connectSshHost({
    alias: sshd.alias,
    controlDirectory: sshd.controlDirectory,
    sshConfigPath: sshd.sshConfigPath,
  });

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (condition: () => boolean, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Condition not met in time.');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const readStream = async (stream: import('node:stream').Readable) => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

test('the PID marker filter removes and reports only a leading marker line', async () => {
  const pids: Array<number> = [];
  const filter = createPidMarkerFilter((pid) => pids.push(pid));
  const output = readStream(filter);
  filter.write('__codiff_pid__:4');
  filter.write('2\r\nreal stderr\n');
  filter.end('__codiff_pid__:7\n');
  expect(await output).toBe('real stderr\n__codiff_pid__:7\n');
  expect(pids).toEqual([42]);

  const plain = createPidMarkerFilter((pid) => pids.push(pid));
  const plainOutput = readStream(plain);
  plain.end('fatal: not a git repository\n');
  expect(await plainOutput).toBe('fatal: not a git repository\n');
  expect(pids).toEqual([42]);
});

describe.skipIf(!findSshd())('SshHost commands', () => {
  test('identifies itself by its ssh destination', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    expect(host.id).toBe('ssh://codiff-test');
    expect(host.label).toBe('codiff-test');
    await host.close();
  });

  test('exec runs a remote command with exact arguments, input, cwd and env', async () => {
    await using sshd = await startTestSshd();
    await using directory = await createTemporaryDirectory("codiff ssh 'cwd' ");
    const host = await connect(sshd);
    const output = await host.exec(
      '/bin/sh',
      ['-c', 'pwd -P; printf "%s|%s|" "$1" "$CODIFF_VALUE"; cat', 'sh', `it's $(id)`],
      { cwd: directory.path, env: { CODIFF_VALUE: 'a "b"' }, input: Buffer.from([0, 1, 255]) },
    );
    const text = output.subarray(0, output.length - 3).toString('utf8');
    expect(text.endsWith(`it's $(id)|a "b"|`)).toBe(true);
    expect(text.split('\n')[0].endsWith(directory.path.split('/').pop()!)).toBe(true);
    expect([...output.subarray(output.length - 3)]).toEqual([0, 1, 255]);
    await host.close();
  });

  test('exec failures match the local error shapes', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    await expect(host.exec('git', ['-C', '/', 'no-such-command'])).rejects.toThrow(
      /^Command failed: git -C \/ no-such-command\n.*no-such-command/s,
    );
    await expect(
      host.exec('/bin/sh', ['-c', 'echo boom >&2; exit 3'], { input: '' }),
    ).rejects.toThrow(/^boom\n$/);
    await expect(host.exec('/bin/sh', ['-c', 'exit 4'], { input: '' })).rejects.toThrow(
      '/bin/sh exited with status 4',
    );
    await host.close();
  });

  test('exec enforces maxBuffer', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    await expect(
      host.exec('/bin/sh', ['-c', 'head -c 5000 /dev/zero'], { maxBuffer: 1000 }),
    ).rejects.toThrow('/bin/sh output exceeded 1000 bytes.');
    await host.close();
  });

  test('aborting exec stops the remote process', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    const pidFile = join(sshd.root, 'exec.pid');
    const controller = new AbortController();
    const running = host.exec('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 30`], {
      signal: controller.signal,
    });
    const { readFileSync, existsSync } = await import('node:fs');
    await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(isRunning(pid)).toBe(true);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await waitUntil(() => !isRunning(pid));
    await host.close();
  });

  test('spawn streams output, reports the exit code and kills the remote process', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    const child = host.spawn('/bin/sh', ['-c', 'printf out; printf err >&2; exit 4']);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise((resolve) => child.on('close', resolve)),
    ]);
    expect({ code, stderr, stdout }).toEqual({ code: 4, stderr: 'err', stdout: 'out' });

    const pidFile = join(sshd.root, 'spawn.pid');
    const sleeper = host.spawn('/bin/sh', ['-c', `echo $$ > '${pidFile}'; exec sleep 30`]);
    sleeper.stdin.end();
    sleeper.stdout.resume();
    sleeper.stderr.resume();
    const { readFileSync, existsSync } = await import('node:fs');
    await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    sleeper.kill();
    await waitUntil(() => !isRunning(pid));
    await host.close();
  });

  test('spawnPty runs in a terminal and streams its output', async () => {
    await using sshd = await startTestSshd();
    const host = await connect(sshd);
    const pty = host.spawnPty(
      '/bin/sh',
      ['-c', 'test -t 1 && echo tty; echo "$TERM"; stty size; exit 3'],
      { cols: 80, name: 'xterm-256color', rows: 24 },
    );
    let output = '';
    pty.onData((data) => {
      output += data;
    });
    const exitCode = await new Promise<number>((resolve) =>
      pty.onExit(({ exitCode }) => resolve(exitCode)),
    );
    expect(exitCode).toBe(3);
    expect(output.replaceAll('\r\n', '\n')).toBe('tty\nxterm-256color\n24 80\n');
    await host.close();
  });
});
```

Notes for the implementer:

- The test `sshd` runs on this machine, so the tests can check remote PIDs with `process.kill(pid, 0)` and read files the remote side wrote.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test electron/__tests__/ssh-host.test.ts`
Expected: FAIL with `Cannot find module '../host/ssh-host.cjs'`.

- [ ] **Step 3: Implement connect, commands and cancellation**

Create `electron/host/ssh-host.cjs`:

```js
// @ts-check

const { EventEmitter } = require('node:events');
const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const {
  RemoteCommandMissingError,
  RemoteShellNoiseError,
  UnsupportedRemoteShellError,
  classifySshFailure,
} = require('./host-errors.cjs');
const {
  PID_MARKER,
  buildCommandScript,
  getShellDialect,
  quotePosix,
  wrapForLoginShell,
} = require('./shell-quote.cjs');
const { createSshConnection } = require('./ssh-connection.cjs');

/**
 * @typedef {import('./repository-host.cjs').HostPty} HostPty
 * @typedef {import('./repository-host.cjs').HostStat} HostStat
 * @typedef {import('./repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('./shell-quote.cjs').ShellDialect} ShellDialect
 * @typedef {import('./ssh-connection.cjs').SshConnection} SshConnection
 * @typedef {import('./ssh-connection.cjs').SshConnectionOptions} SshConnectionOptions
 * @typedef {import('./ssh-connection.cjs').SshResult} SshResult
 * @typedef {'bsd' | 'gnu'} StatFlavor
 * @typedef {RepositoryHost & {close: () => Promise<void>}} SshHost
 */

const DEFAULT_MAX_BUFFER = 1024 * 1024 * 64;
// sshd allows 10 sessions per connection by default (MaxSessions). Queued
// operations use at most 6, leaving room for long-lived spawns, a commit PTY,
// remote kill requests and a fallback session.
const MAX_QUEUED_CHANNELS = 6;
const SHELL_PROBE_PREFIX = '__codiff_shell__:';

/** @param {number} limit */
const createLimiter = (limit) => {
  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  const acquire = () =>
    active < limit
      ? ((active += 1), Promise.resolve())
      : new Promise((resolve) => waiting.push(() => resolve(undefined)));
  // A finished task hands its slot straight to the next waiter.
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  };
  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  return async (task) => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
};

const createAbortError = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

/**
 * Strips a leading `PID_MARKER<pid>` line (as printed by `buildCommandScript`
 * with `announcePid`) from a stream and reports the PID.
 *
 * @param {(pid: number) => void} onPid
 */
const createPidMarkerFilter = (onPid) => {
  let pending = Buffer.alloc(0);
  let done = false;
  return new Transform({
    flush(callback) {
      callback(null, done || pending.length === 0 ? undefined : pending);
    },
    transform(chunk, _encoding, callback) {
      if (done) {
        callback(null, chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const newline = pending.indexOf(10);
      if (newline === -1) {
        if (pending.length > PID_MARKER.length + 32) {
          done = true;
          callback(null, pending);
        } else {
          callback();
        }
        return;
      }
      done = true;
      const line = pending.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      if (line.startsWith(PID_MARKER)) {
        onPid(Number(line.slice(PID_MARKER.length)));
        const rest = pending.subarray(newline + 1);
        callback(null, rest.length > 0 ? rest : undefined);
      } else {
        callback(null, pending);
      }
    },
  });
};

/**
 * @param {{
 *   alias: string;
 *   connection: SshConnection;
 *   dialect: ShellDialect;
 *   masterCheckIntervalMs?: number;
 *   statFlavor: StatFlavor;
 * }} options
 * @returns {SshHost}
 */
const createSshHost = ({
  alias,
  connection,
  dialect,
  masterCheckIntervalMs = 5000,
  statFlavor,
}) => {
  const limit = createLimiter(MAX_QUEUED_CHANNELS);
  let lastMasterCheck = 0;

  // A client whose master vanished connects on its own (ControlMaster=auto);
  // this restores a shared master in the background.
  const keepMasterAlive = () => {
    const now = Date.now();
    if (now - lastMasterCheck >= masterCheckIntervalMs) {
      lastMasterCheck = now;
      void connection.ensureMaster().catch(() => {});
    }
  };

  /** @param {string} script */
  const toRemoteCommand = (script) => wrapForLoginShell(script, dialect);

  // Closing the local ssh client does not stop the remote process.
  /** @param {number} pid */
  const killRemote = (pid) => {
    const child = connection.spawnClient(
      toRemoteCommand(`kill -TERM ${Math.trunc(pid)} 2>/dev/null; :`),
    );
    child.on('error', () => {});
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end();
  };

  /**
   * Exit 255 is either an ssh failure or a command that exited 255. Only a
   * dead master makes it an ssh failure.
   *
   * @param {SshResult} result
   * @returns {Promise<Error | null>}
   */
  const getConnectionError = async (result) => {
    if (result.code !== 255 || (await connection.check())) {
      return null;
    }
    void connection.ensureMaster().catch(() => {});
    return classifySshFailure(alias, result.stderr);
  };

  /**
   * @param {string} script
   * @param {{input?: string | Buffer; label?: string; maxBuffer?: number; signal?: AbortSignal}} [options]
   * @returns {Promise<SshResult>}
   */
  const runScript = (
    script,
    { input, label = 'ssh', maxBuffer = DEFAULT_MAX_BUFFER, signal } = {},
  ) =>
    limit(
      () =>
        new Promise((resolve, reject) => {
          if (signal?.aborted) {
            reject(createAbortError());
            return;
          }
          keepMasterAlive();
          const child = connection.spawnClient(toRemoteCommand(script));
          /** @type {number | null} */
          let pid = null;
          const stderrFilter = createPidMarkerFilter((value) => {
            pid = value;
          });
          /** @type {Array<Buffer>} */
          const stdout = [];
          /** @type {Array<Buffer>} */
          const stderr = [];
          let stdoutBytes = 0;
          let settled = false;
          /** @type {number | null | undefined} */
          let exitCode;
          let stderrEnded = false;

          const abort = () => {
            cancel();
            fail(createAbortError());
          };
          const cleanup = () => signal?.removeEventListener('abort', abort);
          /** @param {Error} error */
          const fail = (error) => {
            if (!settled) {
              settled = true;
              cleanup();
              reject(error);
            }
          };
          const finish = () => {
            if (!settled && exitCode !== undefined && stderrEnded) {
              settled = true;
              cleanup();
              resolve({
                code: exitCode,
                stderr: Buffer.concat(stderr).toString('utf8'),
                stdout: Buffer.concat(stdout),
              });
            }
          };
          const cancel = () => {
            child.kill();
            if (pid != null) {
              killRemote(pid);
            }
          };

          signal?.addEventListener('abort', abort, { once: true });
          child.stdout.on('data', (chunk) => {
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxBuffer) {
              cancel();
              fail(new Error(`${label} output exceeded ${maxBuffer} bytes.`));
              return;
            }
            stdout.push(chunk);
          });
          child.stderr.pipe(stderrFilter);
          stderrFilter.on('data', (chunk) => stderr.push(chunk));
          stderrFilter.on('end', () => {
            stderrEnded = true;
            finish();
          });
          child.stdin.on('error', (error) => {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPIPE') {
              fail(error);
            }
          });
          child.on('error', fail);
          child.on('close', (code) => {
            exitCode = code;
            finish();
          });
          child.stdin.end(input);
        }),
    );

  /** @type {RepositoryHost['exec']} */
  const exec = async (command, args, options = {}) => {
    const result = await runScript(
      buildCommandScript({ announcePid: true, args, command, cwd: options.cwd, env: options.env }),
      {
        input: options.input,
        label: command,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
      },
    );
    if (result.code === 0) {
      return result.stdout;
    }
    const connectionError = await getConnectionError(result);
    if (connectionError) {
      throw connectionError;
    }
    throw new Error(
      options.input === undefined
        ? `Command failed: ${[command, ...args].join(' ')}\n${result.stderr}`
        : result.stderr || `${command} exited with status ${result.code}`,
    );
  };

  /** @type {RepositoryHost['spawn']} */
  const spawn = (command, args, options = {}) => {
    keepMasterAlive();
    const child = connection.spawnClient(
      toRemoteCommand(
        buildCommandScript({
          announcePid: true,
          args,
          command,
          cwd: options.cwd,
          env: options.env,
        }),
      ),
    );
    /** @type {number | null} */
    let pid = null;
    const stderr = createPidMarkerFilter((value) => {
      pid = value;
    });
    child.stderr.pipe(stderr);
    /** @type {number | null | undefined} */
    let exitCode;
    let stderrFinished = false;
    const hostProcess = Object.assign(new EventEmitter(), {
      kill: () => {
        child.kill();
        if (pid != null) {
          killRemote(pid);
        }
        return true;
      },
      stderr,
      stdin: child.stdin,
      stdout: child.stdout,
    });
    // Emit 'close' only after the filtered stderr has received everything.
    const emitClose = () => {
      if (exitCode !== undefined && stderrFinished) {
        setImmediate(() => hostProcess.emit('close', exitCode));
      }
    };
    stderr.on('finish', () => {
      stderrFinished = true;
      emitClose();
    });
    child.on('close', (code) => {
      exitCode = code;
      emitClose();
    });
    child.on('error', (error) => hostProcess.emit('error', error));
    return hostProcess;
  };

  /** @type {RepositoryHost['spawnPty']} */
  const spawnPty = (command, args, options) => {
    keepMasterAlive();
    const script = `stty cols ${Math.trunc(options.cols)} rows ${Math.trunc(options.rows)} 2>/dev/null; ${buildCommandScript(
      {
        announcePid: true,
        args,
        command,
        cwd: options.cwd,
        env: { ...options.env, TERM: options.name },
      },
    )}`;
    const child = connection.spawnClient(toRemoteCommand(script), { tty: true });
    /** @type {number | null} */
    let pid = null;
    const output = createPidMarkerFilter((value) => {
      pid = value;
    });
    const decoder = new StringDecoder('utf8');
    /** @type {Set<(data: string) => void>} */
    const dataListeners = new Set();
    /** @type {Set<(event: {exitCode: number}) => void>} */
    const exitListeners = new Set();
    /** @type {number | null | undefined} */
    let exitCode;
    let outputEnded = false;
    let exited = false;

    /** @param {string} text */
    const emitData = (text) => {
      if (text) {
        for (const listener of dataListeners) {
          listener(text);
        }
      }
    };
    const emitExit = () => {
      if (exited || exitCode === undefined || !outputEnded) {
        return;
      }
      exited = true;
      emitData(decoder.end());
      child.stdin.end();
      for (const listener of exitListeners) {
        listener({ exitCode: exitCode ?? 1 });
      }
    };

    child.stdout.pipe(output);
    output.on('data', (chunk) => emitData(decoder.write(chunk)));
    output.on('end', () => {
      outputEnded = true;
      emitExit();
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      exitCode = code;
      emitExit();
    });
    child.on('error', () => {
      exitCode = 1;
      outputEnded = true;
      emitExit();
    });

    /** @type {HostPty} */
    const pty = {
      kill: () => {
        child.kill();
        if (pid != null) {
          killRemote(pid);
        }
      },
      onData: (listener) => {
        dataListeners.add(listener);
        return { dispose: () => void dataListeners.delete(listener) };
      },
      onExit: (listener) => {
        exitListeners.add(listener);
        return { dispose: () => void exitListeners.delete(listener) };
      },
    };
    return pty;
  };

  const notImplemented = () => Promise.reject(new Error('Not implemented yet.'));

  return Object.freeze({
    close: async () => {
      await connection.exitMaster();
    },
    exec,
    id: `ssh://${alias}`,
    label: alias,
    lstat: notImplemented,
    lstatMany: notImplemented,
    mkdtemp: notImplemented,
    readFile: notImplemented,
    readFiles: notImplemented,
    readlink: notImplemented,
    realpath: notImplemented,
    rename: notImplemented,
    rm: notImplemented,
    spawn,
    spawnPty,
    stat: notImplemented,
    writeFile: notImplemented,
  });
};

/**
 * Connects to an ssh destination: adopts or starts the master, picks the
 * escaping dialect from the login shell, and checks the remote tools.
 *
 * @param {SshConnectionOptions & {connection?: SshConnection; masterCheckIntervalMs?: number}} options
 * @returns {Promise<SshHost>}
 */
const connectSshHost = async ({
  connection: providedConnection,
  masterCheckIntervalMs,
  ...options
}) => {
  const connection = providedConnection ?? createSshConnection(options);
  const { alias } = connection;
  if (!(await connection.check())) {
    await connection.startMaster();
  }

  // The login shell parses this one fixed command; it is valid in every shell.
  const shellResult = await connection.run(`printf '${SHELL_PROBE_PREFIX}%s\\n' "$SHELL"`);
  if (shellResult.code !== 0) {
    throw classifySshFailure(alias, shellResult.stderr, { connected: false });
  }
  const shellLines = shellResult.stdout.toString('utf8').split('\n').filter(Boolean);
  if (shellLines.length !== 1 || !shellLines[0].startsWith(SHELL_PROBE_PREFIX)) {
    throw new RemoteShellNoiseError(alias);
  }
  const shell = shellLines[0].slice(SHELL_PROBE_PREFIX.length);
  const dialect = getShellDialect(shell);
  if (!dialect) {
    throw new UnsupportedRemoteShellError(alias, shell);
  }

  const probe = await connection.run(
    wrapForLoginShell(
      'if stat --version >/dev/null 2>&1; then echo gnu; else echo bsd; fi; for c in git realpath; do command -v "$c" >/dev/null 2>&1 || echo "missing:$c"; done',
      dialect,
    ),
  );
  if (probe.code !== 0) {
    throw classifySshFailure(alias, probe.stderr, { connected: false });
  }
  const probeLines = probe.stdout.toString('utf8').split('\n').filter(Boolean);
  const missing = probeLines.find((line) => line.startsWith('missing:'));
  if (missing) {
    throw new RemoteCommandMissingError(alias, missing.slice('missing:'.length));
  }
  return createSshHost({
    alias,
    connection,
    dialect,
    masterCheckIntervalMs,
    statFlavor: probeLines[0] === 'gnu' ? 'gnu' : 'bsd',
  });
};

module.exports = { connectSshHost, createPidMarkerFilter, createSshHost };
```

`quotePosix` and `HostStat` are imported here because Task 8 uses them. If lint flags them as unused in this task, leave them out and add them back in Task 8.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `vp test electron/__tests__/ssh-host.test.ts`
Expected: PASS.

If the `spawnPty` test's output differs only in line endings or in a leading `stty` echo, inspect the raw output and adjust the implementation, not the expected string. The PTY must deliver exactly the command's output.

- [ ] **Step 5: Gate, check, build and commit**

Run the type-check gate, then:

```bash
vp check --fix
vpr build
git add electron/host/ssh-host.cjs electron/__tests__/ssh-host.test.ts
git commit -m "Run remote commands through an SSH repository host."
```

---

### Task 8: `SshHost` file operations and the full contract

**Files:**

- Modify: `electron/host/ssh-host.cjs`
- Modify: `electron/__tests__/ssh-host.test.ts`

**Interfaces:**

- Consumes: Task 7's `createSshHost` internals (`runScript`, `getConnectionError`, `limit`), `quotePosix` (Task 3), and `defineRepositoryHostContract` (Task 1).
- Produces:
  - The remaining `RepositoryHost` methods on `SshHost`.
  - Pure helpers exported for tests: `parseStatLine(line: string): HostStat`, `parseStatLines(output: Buffer, count: number): Array<HostStat | null>`, `parseReadFilesOutput(output: Buffer, paths: ReadonlyArray<string>): Array<Buffer | Error>` and `chunkByScriptSize(paths: ReadonlyArray<string>): Array<Array<string>>`.

- [ ] **Step 1: Write the failing tests**

Add to `electron/__tests__/ssh-host.test.ts`. Extend the `require` cast with the four helpers, and import `defineRepositoryHostContract` from `./helpers/repository-host-contract.ts`:

```ts
test('parses GNU and BSD stat output into host stats', () => {
  expect(parseStatLine('81a4 401 72290885 1769911025.860883671 1777163364.430570372')).toEqual({
    ctimeMs: 1777163364.430570372 * 1000,
    ino: 72290885,
    mode: 0o100644,
    mtimeMs: 1769911025.860883671 * 1000,
    size: 401,
    type: 'file',
  });
  expect(parseStatLine('41ed 64 2 1.5 1.5').type).toBe('directory');
  expect(parseStatLine('a1ff 8 3 1.5 1.5').type).toBe('symlink');
  expect(parseStatLine('11a4 0 4 1.5 1.5').type).toBe('other');
});

test('parses batched stat output and rejects misaligned output', () => {
  const stats = parseStatLines(Buffer.from('OK 81a4 1 2 1.5 1.5\nERR\nOK 41ed 64 3 2.5 2.5\n'), 3);
  expect(stats.map((stat) => stat?.type ?? null)).toEqual(['file', null, 'directory']);
  expect(() => parseStatLines(Buffer.from('OK 81a4 1 2 1.5 1.5\n'), 2)).toThrow(
    'Unexpected stat output.',
  );
});

test('parses length-framed batch reads, including newlines in contents', () => {
  const output = Buffer.concat([
    Buffer.from('OK 3\na\nb'),
    Buffer.from('ERR\n'),
    Buffer.from('OK 0\n'),
    Buffer.from('OK 2\n'),
    Buffer.from([0, 255]),
  ]);
  const results = parseReadFilesOutput(output, ['/a', '/missing', '/empty', '/binary']);
  expect(results[0]).toEqual(Buffer.from('a\nb'));
  expect(results[1]).toBeInstanceOf(Error);
  expect(results[2]).toEqual(Buffer.alloc(0));
  expect(results[3]).toEqual(Buffer.from([0, 255]));
  expect(() => parseReadFilesOutput(Buffer.from('OK 9\nabc'), ['/a'])).toThrow(
    'Unexpected batch read output.',
  );
});

test('splits large path batches below the remote argument limit', () => {
  const paths = Array.from(
    { length: 3000 },
    (_, index) => `/repo/${'d'.repeat(40)}/file-${index}.txt`,
  );
  const chunks = chunkByScriptSize(paths);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flat()).toEqual(paths);
  for (const chunk of chunks) {
    expect(
      chunk.map((path) => path.length + 3).reduce((sum, size) => sum + size, 0),
    ).toBeLessThanOrEqual(64 * 1024);
  }
});

describe.skipIf(!findSshd())('SshHost contract', () => {
  let sshd: TestSshd;
  let host: SshHost;

  beforeAll(async () => {
    sshd = await startTestSshd();
    host = await connect(sshd);
  });

  afterAll(async () => {
    await host?.close();
    await sshd?.stop();
  });

  defineRepositoryHostContract('SshHost', async () => {
    const root = await host.mkdtemp('codiff-ssh-contract-');
    return {
      host,
      root,
      [Symbol.asyncDispose]: () => host.rm(root, { force: true, recursive: true }),
    };
  });
});

describe.skipIf(!findSshd())('SshHost batching', () => {
  test('batched calls use one remote command per chunk and none for empty input', async () => {
    await using sshd = await startTestSshd();
    const spawned: Array<string> = [];
    const { spawn } = await import('node:child_process');
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      spawnProcess: ((command: string, args: ReadonlyArray<string>, options: object) => {
        spawned.push(args.at(-1) ?? '');
        return spawn(command, [...args], options);
      }) as unknown as typeof spawn,
      sshConfigPath: sshd.sshConfigPath,
    } as Parameters<typeof connectSshHost>[0]);
    const root = await host.mkdtemp('codiff-ssh-batch-');
    const paths = await Promise.all(
      Array.from({ length: 50 }, async (_, index) => {
        const path = join(root, `file-${index}.txt`);
        await host.writeFile(path, `value ${index}`);
        return path;
      }),
    );
    spawned.length = 0;
    expect(await host.lstatMany([])).toEqual([]);
    expect(await host.readFiles([])).toEqual([]);
    expect(spawned).toEqual([]);
    const stats = await host.lstatMany(paths);
    const contents = await host.readFiles(paths);
    expect(stats.every((stat) => stat?.type === 'file')).toBe(true);
    expect(contents.map((value) => value.toString())).toEqual(
      paths.map((_, index) => `value ${index}`),
    );
    expect(spawned.filter((command) => !command.includes('-O'))).toHaveLength(2);
    await host.rm(root, { force: true, recursive: true });
    await host.close();
  });
});
```

Add `afterAll`, `beforeAll` to the `vite-plus/test` import. The batching test passes `spawnProcess` through `connectSshHost` to `createSshConnection`. Its cast is needed because the public type omits test-only options; if the type-check gate rejects it, widen the JSDoc of `connectSshHost`'s options to include `spawnProcess` rather than adding more casts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `vp test electron/__tests__/ssh-host.test.ts`
Expected: the parser tests FAIL because the helpers aren't exported. The contract tests FAIL with `Not implemented yet.`

- [ ] **Step 3: Add the parsers and chunking**

Add these near the top of `electron/host/ssh-host.cjs`, after `SHELL_PROBE_PREFIX`:

```js
// Linux caps one argument (the remote command string) at 128 KiB.
const MAX_BATCH_SCRIPT_BYTES = 64 * 1024;
/** @type {Record<StatFlavor, string>} */
const STAT_FORMATS = {
  bsd: "-f '%Xp %z %i %Fm %Fc'",
  gnu: "-c '%f %s %i %.9Y %.9Z'",
};

/** @param {string} line @returns {HostStat} */
const parseStatLine = (line) => {
  const [mode, size, ino, mtime, ctime] = line.trim().split(' ');
  const modeNumber = Number.parseInt(mode, 16);
  const typeBits = modeNumber & 0o170000;
  return {
    ctimeMs: Number(ctime) * 1000,
    ino: Number(ino),
    mode: modeNumber,
    mtimeMs: Number(mtime) * 1000,
    size: Number(size),
    type:
      typeBits === 0o120000
        ? 'symlink'
        : typeBits === 0o040000
          ? 'directory'
          : typeBits === 0o100000
            ? 'file'
            : 'other',
  };
};

/** @param {Buffer} output @param {number} count @returns {Array<HostStat | null>} */
const parseStatLines = (output, count) => {
  const lines = output.toString('utf8').split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  if (lines.length !== count) {
    throw new Error('Unexpected stat output.');
  }
  return lines.map((line) => (line.startsWith('OK ') ? parseStatLine(line.slice(3)) : null));
};

/** @param {Buffer} output @param {ReadonlyArray<string>} paths @returns {Array<Buffer | Error>} */
const parseReadFilesOutput = (output, paths) => {
  /** @type {Array<Buffer | Error>} */
  const results = [];
  let offset = 0;
  for (const path of paths) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) {
      throw new Error('Unexpected batch read output.');
    }
    const header = output.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    if (header === 'ERR') {
      results.push(new Error(`Cannot read ${path}.`));
      continue;
    }
    const match = /^OK (\d+)$/.exec(header);
    const size = match ? Number(match[1]) : -1;
    if (size < 0 || offset + size > output.length) {
      throw new Error('Unexpected batch read output.');
    }
    results.push(Buffer.from(output.subarray(offset, offset + size)));
    offset += size;
  }
  return results;
};

/** @param {ReadonlyArray<string>} paths @returns {Array<Array<string>>} */
const chunkByScriptSize = (paths) => {
  /** @type {Array<Array<string>>} */
  const chunks = [];
  let current = [];
  let size = 0;
  for (const path of paths) {
    const quotedSize = quotePosix(path).length + 1;
    if (current.length > 0 && size + quotedSize > MAX_BATCH_SCRIPT_BYTES) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(path);
    size += quotedSize;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
};
```

Export `chunkByScriptSize`, `parseReadFilesOutput`, `parseStatLine` and `parseStatLines`.

- [ ] **Step 4: Implement the file operations**

Inside `createSshHost`, replace `notImplemented` and its uses with the following, placed after `spawnPty`:

```js
const statFormat = STAT_FORMATS[statFlavor];

/** @param {string} path */
const assertAbsolute = (path) => {
  if (!path.startsWith('/')) {
    throw new Error(`SSH host paths must be absolute: ${path}`);
  }
  return path;
};

/**
 * @param {string} operation
 * @param {string} subject
 * @param {string} script
 * @param {{input?: string | Buffer}} [options]
 */
const run = async (operation, subject, script, options = {}) => {
  const result = await runScript(script, { input: options.input, label: operation });
  if (result.code === 0) {
    return result.stdout;
  }
  const connectionError = await getConnectionError(result);
  if (connectionError) {
    throw connectionError;
  }
  throw new Error(
    `${operation} ${subject}: ${result.stderr.trim() || `exited with status ${result.code}`}`,
  );
};

/** @param {string} path @param {boolean} follow */
const statPath = async (path, follow) =>
  parseStatLine(
    (
      await run(
        follow ? 'stat' : 'lstat',
        path,
        `exec stat ${follow ? '-L ' : ''}${statFormat} ${quotePosix(assertAbsolute(path))}`,
      )
    ).toString('utf8'),
  );

/** @type {RepositoryHost['lstatMany']} */
const lstatMany = async (paths) => {
  /** @type {Array<HostStat | null>} */
  const results = [];
  for (const chunk of chunkByScriptSize(paths.map(assertAbsolute))) {
    const output = await run(
      'lstat',
      `${chunk.length} paths`,
      [
        `set -- ${chunk.map(quotePosix).join(' ')}`,
        // One stat for the common case; per-path only when something is missing.
        `if out=$(stat ${statFormat} "$@" 2>/dev/null); then printf '%s\\n' "$out" | sed 's/^/OK /'; else for p do if line=$(stat ${statFormat} "$p" 2>/dev/null); then printf 'OK %s\\n' "$line"; else echo ERR; fi; done; fi`,
      ].join('\n'),
    );
    results.push(...parseStatLines(output, chunk.length));
  }
  return results;
};

/** @type {RepositoryHost['readFiles']} */
const readFiles = async (paths) => {
  /** @type {Array<Buffer | Error>} */
  const results = [];
  for (const chunk of chunkByScriptSize(paths.map(assertAbsolute))) {
    const output = await run(
      'readFile',
      `${chunk.length} paths`,
      [
        `set -- ${chunk.map(quotePosix).join(' ')}`,
        'for p do',
        '  if [ -f "$p" ] && [ -r "$p" ] && n=$(wc -c < "$p"); then',
        "    n=$(printf '%s' \"$n\" | tr -d ' ')",
        '    printf \'OK %s\\n\' "$n"',
        // Exactly n bytes even if the file changes while it is read.
        '    cat "$p" /dev/zero 2>/dev/null | head -c "$n"',
        '  else',
        '    echo ERR',
        '  fi',
        'done',
      ].join('\n'),
    );
    results.push(...parseReadFilesOutput(output, chunk));
  }
  return results;
};

/** @param {Buffer} output */
const withoutTrailingNewline = (output) => output.toString('utf8').replace(/\n$/, '');

/** @type {RepositoryHost['writeFile']} */
const writeFile = async (path, contents, options = {}) => {
  const target = quotePosix(assertAbsolute(path));
  const mode = options.mode == null ? null : (options.mode & 0o7777).toString(8);
  const script = options.exclusive
    ? `set -C && : > ${target} && ${mode ? `chmod ${mode} ${target} && ` : ''}exec cat >| ${target}`
    : `${mode ? `if [ ! -e ${target} ]; then : > ${target} && chmod ${mode} ${target}; fi && ` : ''}exec cat > ${target}`;
  await run('writeFile', path, script, { input: contents });
};

/** @type {RepositoryHost['mkdtemp']} */
const mkdtemp = async (prefix) => {
  if (!/^[\w.-]+$/.test(prefix)) {
    throw new Error(`Invalid temporary directory prefix: ${prefix}`);
  }
  return withoutTrailingNewline(
    await run(
      'mkdtemp',
      prefix,
      `dir=\${TMPDIR:-/tmp}; exec mktemp -d "\${dir%/}/${prefix}XXXXXX"`,
    ),
  );
};
```

Then use them in the returned object:

```js
return Object.freeze({
  close: async () => {
    await connection.exitMaster();
  },
  exec,
  id: `ssh://${alias}`,
  label: alias,
  lstat: (path) => statPath(path, false),
  lstatMany,
  mkdtemp,
  readFile: async (path) => run('readFile', path, `exec cat ${quotePosix(assertAbsolute(path))}`),
  readFiles,
  readlink: async (path) =>
    withoutTrailingNewline(
      await run('readlink', path, `exec readlink ${quotePosix(assertAbsolute(path))}`),
    ),
  realpath: async (path) =>
    withoutTrailingNewline(
      await run('realpath', path, `exec realpath ${quotePosix(assertAbsolute(path))}`),
    ),
  rename: async (from, to) => {
    await run(
      'rename',
      from,
      `exec mv -f ${quotePosix(assertAbsolute(from))} ${quotePosix(assertAbsolute(to))}`,
    );
  },
  rm: async (path, options = {}) => {
    const flags = `${options.recursive ? 'r' : ''}${options.force ? 'f' : ''}`;
    await run(
      'rm',
      path,
      `exec rm ${flags ? `-${flags} ` : ''}${quotePosix(assertAbsolute(path))}`,
    );
  },
  spawn,
  spawnPty,
  stat: (path) => statPath(path, true),
  writeFile,
});
```

Note: `assertAbsolute` throws synchronously inside `async` arrow functions, so it surfaces as a rejection. That is consistent with `LocalHost`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `vp test electron/__tests__/ssh-host.test.ts electron/__tests__/local-host.test.ts`
Expected: PASS. The full contract, including the Task 1 additions, passes on both hosts.

If a contract test fails on `SshHost`, fix `SshHost`. Change a contract test only if it asserts `LocalHost`-only behavior that the interface comment in `repository-host.cjs` does not promise, and record that in your report.

- [ ] **Step 6: Gate, suite, check, build and commit**

Run the type-check gate and the full `vp test` (expect exactly the 2 known baseline failures), then:

```bash
vp check --fix
vpr build
git add electron/host/ssh-host.cjs electron/__tests__/ssh-host.test.ts
git commit -m "Add file operations to the SSH repository host."
```

---

### Task 9: Connection failure modes

**Files:**

- Create: `electron/__tests__/ssh-host-failures.test.ts`
- Modify: `electron/host/ssh-host.cjs` (only if the tests expose a defect)

**Interfaces:**

- Consumes: `connectSshHost` (Tasks 7 and 8), `createSshConnection` (Task 6), `startTestSshd` (Task 5) and the host errors (Task 4).
- Produces: nothing new. This task pins behavior.

- [ ] **Step 1: Write the tests**

Create `electron/__tests__/ssh-host-failures.test.ts`:

```ts
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vite-plus/test';
import type { RepositoryHost } from '../host/repository-host.cjs';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';

type SshResult = { code: number | null; stderr: string; stdout: Buffer };
type SshHost = RepositoryHost & { close: () => Promise<void> };
type FakeConnection = {
  alias: string;
  check: () => Promise<boolean>;
  ensureMaster: () => Promise<void>;
  exitMaster: () => Promise<void>;
  run: (remoteCommand: string) => Promise<SshResult>;
  spawnClient: () => never;
  startMaster: () => Promise<void>;
};

const require = createRequire(import.meta.url);
const { connectSshHost } = require('../host/ssh-host.cjs') as {
  connectSshHost: (options: {
    alias?: string;
    connection?: FakeConnection;
    controlDirectory?: string;
    masterCheckIntervalMs?: number;
    sshConfigPath?: string;
  }) => Promise<SshHost>;
};
const { createSshConnection } = require('../host/ssh-connection.cjs') as {
  createSshConnection: (options: {
    alias: string;
    controlDirectory: string;
    sshConfigPath: string;
  }) => {
    check: () => Promise<boolean>;
    exitMaster: () => Promise<void>;
  };
};

const createFakeConnection = (outputs: ReadonlyArray<string>): FakeConnection => {
  const queue = [...outputs];
  return {
    alias: 'devbox',
    check: async () => true,
    ensureMaster: async () => {},
    exitMaster: async () => {},
    run: async () => ({ code: 0, stderr: '', stdout: Buffer.from(queue.shift() ?? '') }),
    spawnClient: () => {
      throw new Error('not used');
    },
    startMaster: async () => {},
  };
};

test('a csh login shell is rejected', async () => {
  await expect(
    connectSshHost({ connection: createFakeConnection(['__codiff_shell__:/bin/tcsh\n']) }),
  ).rejects.toMatchObject({
    message: 'Codiff needs a POSIX or fish login shell on devbox.',
    name: 'UnsupportedRemoteShellError',
  });
});

test('shell startup files that print output are rejected', async () => {
  await expect(
    connectSshHost({
      connection: createFakeConnection(['Welcome to devbox!\n__codiff_shell__:/bin/bash\n']),
    }),
  ).rejects.toMatchObject({ name: 'RemoteShellNoiseError' });
});

test('a missing git is reported by name', async () => {
  await expect(
    connectSshHost({
      connection: createFakeConnection(['__codiff_shell__:/usr/bin/fish\n', 'gnu\nmissing:git\n']),
    }),
  ).rejects.toMatchObject({
    message: "git isn't installed on devbox.",
    name: 'RemoteCommandMissingError',
  });
});

describe.skipIf(!findSshd())('SshHost connection failures', () => {
  test('an unauthorized key needs an interactive login', async () => {
    await using sshd = await startTestSshd({ authorize: false });
    await expect(
      connectSshHost({
        alias: sshd.alias,
        controlDirectory: sshd.controlDirectory,
        sshConfigPath: sshd.sshConfigPath,
      }),
    ).rejects.toMatchObject({ name: 'HostAuthRequiredError' });
  });

  test('an unreachable host reports ssh output', async () => {
    await using sshd = await startTestSshd();
    await expect(
      connectSshHost({
        alias: sshd.unreachableAlias,
        controlDirectory: sshd.controlDirectory,
        sshConfigPath: sshd.sshConfigPath,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/Connection refused/),
      name: 'HostUnreachableError',
    });
  });

  test('a command that exits 255 is a command failure, not a lost connection', async () => {
    await using sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await expect(
      host.exec('/bin/sh', ['-c', 'echo hook failed >&2; exit 255']),
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /^Command failed: \/bin\/sh -c echo hook failed >&2; exit 255\nhook failed/,
      ),
      name: 'Error',
    });
    await host.close();
  });

  test('operations survive a lost master and the master comes back', async () => {
    await using sshd = await startTestSshd();
    const options = {
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    };
    const host = await connectSshHost({ ...options, masterCheckIntervalMs: 0 });
    const connection = createSshConnection(options);
    await connection.exitMaster();
    expect(await connection.check()).toBe(false);

    expect((await host.exec('printf', ['still here'])).toString('utf8')).toBe('still here');

    const deadline = Date.now() + 10_000;
    while (!(await connection.check())) {
      if (Date.now() > deadline) {
        throw new Error('The master did not come back.');
      }
      await host.exec('true', []);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await host.close();
  });

  test('a stopped server is a lost connection', async () => {
    const sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      controlDirectory: sshd.controlDirectory,
      sshConfigPath: sshd.sshConfigPath,
    });
    await sshd.stop();
    await expect(host.exec('true', [])).rejects.toMatchObject({
      message: 'Lost connection to codiff-test.',
      name: 'HostDisconnectedError',
    });
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `vp test electron/__tests__/ssh-host-failures.test.ts`
Expected: PASS. These pin behavior that Tasks 6–8 built. If one fails, find the defect in `ssh-host.cjs` or `ssh-connection.cjs`, fix it there, and record the RED/GREEN evidence. Do not weaken an expectation.

One known risk: after the master is killed, the very next client may itself become a temporary master (`ControlMaster=auto`). `connection.check()` can then briefly report `true` before the persistent master returns. That is acceptable; the test only requires that the master comes back.

- [ ] **Step 3: Gate, check, build and commit**

Run the type-check gate, then:

```bash
vp check --fix
vpr build
git add electron/__tests__/ssh-host-failures.test.ts electron/host/ssh-host.cjs electron/host/ssh-connection.cjs
git commit -m "Pin SSH host behavior when connections fail."
```

(Stage `ssh-host.cjs` and `ssh-connection.cjs` only if you changed them.)

---

### Task 10: Run the git-state suites over SSH

**Files:**

- Create: `core/__tests__/helpers/test-host.ts`
- Modify (replace their `createLocalHost()` setup with the shared `host`):
  - `core/__tests__/git-state.test.ts`
  - `core/__tests__/git-files.test.ts`
  - `electron/__tests__/repository-watcher.test.ts`
  - `electron/__tests__/definition-search.test.ts`
  - `electron/__tests__/walkthrough-commit.test.ts`
  - `electron/__tests__/repository-file.test.ts`
  - `electron/__tests__/window-identity.test.ts`
  - `electron/__tests__/review-source.test.ts`
  - `electron/__tests__/git-identity.test.ts`
- Modify: `.github/workflows/test.yml`
- Modify: `electron/host/ssh-host.cjs` (for any defect the suites expose)

**Interfaces:**

- Consumes: `connectSshHost` (Tasks 7 and 8) and `startTestSshd` (Task 5).
- Produces:
  - `host: RepositoryHost`, the `LocalHost` by default, or an `SshHost` connected to a per-file test `sshd` when `CODIFF_TEST_HOST=ssh`.
  - `testHostKind: 'local' | 'ssh'`.

- [ ] **Step 1: Create the shared test host**

Create `core/__tests__/helpers/test-host.ts`:

```ts
import { createRequire } from 'node:module';
import { afterAll } from 'vite-plus/test';
import { startTestSshd } from '../../../electron/__tests__/helpers/test-sshd.ts';
import type { RepositoryHost } from '../../../electron/host/repository-host.cjs';

/**
 * The repository host the git-state suites run against. Local by default; with
 * `CODIFF_TEST_HOST=ssh` every suite that imports this runs over a real ssh
 * connection to a throwaway sshd on 127.0.0.1, so the same assertions prove
 * that SshHost behaves like LocalHost. The test process's GIT_* variables are
 * forwarded (SendEnv/AcceptEnv), so Git identity and hook isolation still apply.
 *
 *   CODIFF_TEST_HOST=ssh vp test core/__tests__/git-state.test.ts ...
 */
const require = createRequire(import.meta.url);
const { createLocalHost } = require('../../../electron/host/local-host.cjs') as {
  createLocalHost: () => RepositoryHost;
};
const { connectSshHost } = require('../../../electron/host/ssh-host.cjs') as {
  connectSshHost: (options: {
    alias: string;
    controlDirectory: string;
    sshConfigPath: string;
  }) => Promise<RepositoryHost & { close: () => Promise<void> }>;
};

export const testHostKind: 'local' | 'ssh' =
  process.env.CODIFF_TEST_HOST === 'ssh' ? 'ssh' : 'local';

const createTestHost = async (): Promise<RepositoryHost> => {
  if (testHostKind === 'local') {
    return createLocalHost();
  }
  const sshd = await startTestSshd();
  const sshHost = await connectSshHost({
    alias: sshd.alias,
    controlDirectory: sshd.controlDirectory,
    sshConfigPath: sshd.sshConfigPath,
  });
  afterAll(async () => {
    await sshHost.close();
    await sshd.stop();
  });
  return sshHost;
};

export const host = await createTestHost();
```

- [ ] **Step 2: Point the suites at the shared host**

In each file listed above:

- Delete the `createLocalHost` require and `const host = createLocalHost();`.
- Add `import { host, testHostKind } from '<relative path>/helpers/test-host.ts';`: `./helpers/test-host.ts` from `core/__tests__`, or `../../core/__tests__/helpers/test-host.ts` from `electron/__tests__`.
- Import only `host` if the file doesn't use `testHostKind`.
- Keep every existing assertion.

Run: `vp test core/__tests__/git-state.test.ts core/__tests__/git-files.test.ts electron/__tests__/repository-watcher.test.ts electron/__tests__/definition-search.test.ts electron/__tests__/walkthrough-commit.test.ts electron/__tests__/repository-file.test.ts electron/__tests__/window-identity.test.ts electron/__tests__/review-source.test.ts electron/__tests__/git-identity.test.ts`
Expected: the same results as before, with only the known bounded-process baseline failure among these files.

- [ ] **Step 3: Run the suites over SSH and record the RED state**

```bash
CODIFF_TEST_HOST=ssh vp test core/__tests__/git-state.test.ts core/__tests__/git-files.test.ts electron/__tests__/repository-watcher.test.ts electron/__tests__/definition-search.test.ts electron/__tests__/walkthrough-commit.test.ts electron/__tests__/repository-file.test.ts electron/__tests__/window-identity.test.ts electron/__tests__/review-source.test.ts electron/__tests__/git-identity.test.ts
```

Record every failure in your report. Each one is either an `SshHost` defect or a test that asserts behavior only a local host can have.

- [ ] **Step 4: Fix `SshHost` defects**

For each failure caused by `SshHost` behaving differently from `LocalHost`, fix `electron/host/ssh-host.cjs` (or `ssh-connection.cjs`). Then rerun the single failing test with `CODIFF_TEST_HOST=ssh vp test <file> -t "<test name>"` and record the RED/GREEN evidence.

Typical differences to look for:

- error text
- trailing newlines
- symlink handling
- `realpath` of `/tmp` versus `/private/tmp`
- exit-code mapping
- PTY output for commit hooks

- [ ] **Step 5: Skip only tests that are inherently local**

A test may be skipped under SSH only if it asserts something that cannot be true over SSH. One example is a test that injects a fake child process into a function that bypasses the host. Use `test.skipIf(testHostKind === 'ssh')(...)` and put a one-line comment above it saying why.

List every skip in your report with its reason. Do not skip a test to hide an `SshHost` defect. The bounded-process test counts Git processes through a `GIT_TRACE2_EVENT` file that is forwarded to the remote side, so it must keep passing or keep failing exactly as it does locally (at most 16).

- [ ] **Step 6: Run the suites over SSH in CI**

In `.github/workflows/test.yml`, add a step after `vp run test:all`:

```yaml
- name: Test repository code over SSH
  run: |
    CODIFF_TEST_HOST=ssh vp test core/__tests__/git-state.test.ts core/__tests__/git-files.test.ts electron/__tests__/repository-watcher.test.ts electron/__tests__/definition-search.test.ts electron/__tests__/walkthrough-commit.test.ts electron/__tests__/repository-file.test.ts electron/__tests__/window-identity.test.ts electron/__tests__/review-source.test.ts electron/__tests__/git-identity.test.ts
```

- [ ] **Step 7: Verify everything, then check, build and commit**

```bash
vp test
CODIFF_TEST_HOST=ssh vp test core/__tests__/git-state.test.ts core/__tests__/git-files.test.ts electron/__tests__/repository-watcher.test.ts electron/__tests__/definition-search.test.ts electron/__tests__/walkthrough-commit.test.ts electron/__tests__/repository-file.test.ts electron/__tests__/window-identity.test.ts electron/__tests__/review-source.test.ts electron/__tests__/git-identity.test.ts
vp check --fix
vpr build
```

Expected:

- `vp test` shows exactly the 2 known baseline failures.
- The SSH run shows only the bounded-process baseline failure (at most 16 processes), and any skipped tests are the ones listed in your report.
- The type-check gate passes.

Then commit with explicit paths: the new helper, the nine test files, the workflow, and any changed host files.

```bash
git commit -m "Run the repository suites over SSH."
```

---

## Follow-on plans

- **Phase 3, entry points:**
  - CLI remote targets, with the master started in the terminal and adopted by the app.
  - Host-qualified identity and cache keys.
  - The Open Remote Repository dialog and recents.
  - The title indicator and disconnected banner.
  - Running ssh with the login-shell environment from `login-shell-environment.cjs` (pass it as `getLocalEnvironment`).
  - The Phase 3 items carried forward in the Phase 1 plan.
- **Phase 4, remote walkthroughs:**
  - `readdir`, `readFileTail`, `getEnvironment` (the captured remote login environment) and `resolveCommand`.
  - Agent runners and session-context readers through the host.
- **Phase 5:** docs, the 1000-untracked-file benchmark over `SshHost`, and the manual checklist.
