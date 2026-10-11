# SSH Remote Repositories: Design

Status: Implemented locally through Phase 5; external release validation remains.

Progress: [Overall implementation record](../ssh-remote-progress.md).
Date: 2026-10-10

## Goal

Let Codiff, running on a laptop, review and change a Git repository that lives on a remote machine
reachable over SSH, e.g. `codiff devbox:~/src/app`. Nothing is installed on the remote beyond what
is already needed to work there (`git`, a POSIX or fish login shell, and optionally an agent CLI for
walkthroughs).

### What success looks like

- Opening a remote repository from the CLI or the app shows the same review UI as a local one.
- Status, diffs, commit/branch/compare views, history, live refresh, definition search, saving
  edits, staging and committing all work on the remote repository.
- Narrative walkthroughs run with the agent CLI installed on the remote host.
- SSH behaves exactly as it does in the user's terminal (`~/.ssh/config`, `ProxyJump`, agents such
  as 1Password, hardware keys, `known_hosts`).

### Decisions made during brainstorming

- Workflow: Codiff runs locally and connects out to the remote. Launching `codiff` from inside an
  SSH session (reverse channel) is not part of this design.
- Transport: the system `ssh` binary with connection multiplexing, not a JS SSH library and not a
  remote helper process.
- The repository host is passed explicitly to every function that touches a repository. There is
  no global lookup and no path-based dispatch.
- Remote commands are sent as plain, correctly escaped shell text (no base64 wrapping).
- Interactive authentication happens in the user's terminal via the CLI. No askpass in v1.

### Out of scope for v1

- Windows (OpenSSH for Windows has no `ControlMaster`).
- GitHub PR / GitLab MR review (`gh` / `glab`) for remote repositories.
- Open in Editor and Show in Folder for remote repositories.
- Askpass-based interactive authentication from the app.
- Launching Codiff from inside an SSH session on the remote machine.

## Architecture

### `RepositoryHost`

A `RepositoryHost` is the only way code reaches a repository's machine. It has two
implementations: `LocalHost` (wraps today's `child_process`, `node-pty` and `fs` usage with no
behavior change) and `SshHost`.

```ts
interface RepositoryHost {
  readonly id: string; // 'local' or 'ssh://<host-alias>'
  readonly label: string; // '' for local, '<host-alias>' for SSH

  exec(
    command: string,
    args: ReadonlyArray<string>,
    options?: {
      cwd?: string;
      encoding?: BufferEncoding | 'buffer';
      env?: Record<string, string>;
      input?: string | Buffer;
      maxBuffer?: number;
      signal?: AbortSignal;
    },
  ): Promise<string | Buffer>;

  spawn(
    command: string,
    args: ReadonlyArray<string>,
    options: { cwd?: string; env?: Record<string, string>; pty?: boolean },
  ): HostProcess; // stdin/stdout/stderr streams, exit event, kill()

  lstat(path: string): Promise<HostStat | null>; // type, size, executable
  lstatMany(paths: ReadonlyArray<string>): Promise<Array<HostStat | null>>;
  readFile(path: string): Promise<Buffer>;
  readFiles(paths: ReadonlyArray<string>): Promise<Array<Buffer | Error>>;
  readFileTail(path: string, maxBytes: number): Promise<Buffer>;
  readlink(path: string): Promise<string>;
  readdir(
    path: string,
  ): Promise<Array<{ name: string; type: 'file' | 'directory' | 'symlink' | 'other' }>>;
  writeFile(path: string, contents: string | Buffer): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  rm(path: string, options?: { recursive?: boolean }): Promise<void>;

  getEnvironment(): Promise<Record<string, string>>; // login-shell environment of that machine
  resolveCommand(name: string): Promise<string | null>; // `command -v` against that environment's PATH
}
```

`git(host, repoPath, args)`, `gitBuffer(host, repoPath, args)` and
`gitBufferWithInput(host, repoPath, args, input, options)` in `electron/git-state/common.cjs`
become thin wrappers over `host.exec('git', ['-C', repoPath, ...args], ...)`.

`repoPath` is always a plain absolute path on the machine that `host` refers to.

### Explicit host threading

Every function that touches a repository takes `host` as its first parameter, for example
`readRepositoryState(host, repoPath, source)`, `findDefinitions(host, repoPath, ...)`,
`createWalkthroughCommit(host, repoPath, ...)`, the repository watcher, generated-file detection,
session-context readers and the agent runners.

Ownership:

- **App startup**: `main.cjs` creates one `LocalHost` and a `HostRegistry`.
- **Opening a repository** (CLI launch, Open Repository, Open Remote Repository): the entry point
  resolves the target to `{host, repoPath}`. For SSH targets it gets or creates the `SshHost` for
  that alias from the registry, connects it, resolves `~` and the repository toplevel. The registry
  is consulted only at these entry points; one alias shares one `SshHost` across windows.
- **Each window** stores its `{host, repoPath}`. IPC handlers read it from the window context and
  pass both down. Nothing below the IPC layer creates or looks up a host.
- **Closing**: when the last window using an `SshHost` closes, and on quit, the host is closed
  (see Master connection).

Synchronous `execFileSync('git', ...)` call sites become async calls through the host:
`electron/window-identity.cjs`, `electron/review-source.cjs`, `electron/main/command-line.cjs` and
`bin/arguments.js`.

### Identity

Window identity, the walkthrough cache key, `lastRepositoryPath`, recent remotes, viewed state,
pending comments and plan reviews are keyed by `host.id` plus `repoPath`. All of this state stays
local in `~/.codiff` / app userData. `/src/app` on the laptop and `/src/app` on `devbox` are
distinct.

## `SshHost` transport

### Master connection

All SSH invocations share:

```
-S ~/.codiff/ssh/%C
-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
```

`%C` keeps the filename short; the full socket path must still fit the 104-byte macOS limit.
Pass the path via `-S` to preserve quotes and spaces, and escape literal `%` in the directory
as `%%` while retaining the final `%C` token. Every invocation disables `RemoteCommand`,
forwardings and `LocalCommand` with `RemoteCommand=none`, `ClearAllForwardings=yes` and
`PermitLocalCommand=no`.

- **CLI with a TTY**: `codiff devbox:~/app` runs `ssh -O check` on the ControlPath. If no master
  is running, it runs `ssh -M -f -N -o ControlPersist=yes ...` in the terminal so password, 2FA
  and host-key prompts appear there. `-f` backgrounds the master after authentication, so it
  outlives the CLI process. The CLI then hands off to the app.
- **App `SshHost.open()`**: if `ssh -O check` finds a live master, the host adopts it. Otherwise it
  spawns a master with `-N -o ControlMaster=yes -o ControlPersist=yes -o ForkAfterAuthentication=no -o BatchMode=yes`.
  `ControlPersist` backgrounds it after it binds the socket. A start that loses the socket to
  another instance stays a direct child; the app stops that child and adopts the winner.
  The app captures startup stderr at `LogLevel=INFO`, with a 30-second startup timeout.
- **All other operations** run as clients with
  `-o ControlMaster=no -o ControlPersist=no -o ProxyCommand=false -o BatchMode=yes`. They only
  multiplex over the persistent master. Without it, `ProxyCommand=false` blocks an independent
  connection and the operation fails promptly. Exit 255 plus a failed `-O check` produces
  `HostDisconnectedError` and starts master recovery in the background. The failed operation
  is never automatically retried; later operations can use the restored master. The master
  still honors the user’s `ProxyJump` or `ProxyCommand` settings. Resolve `%C` from the master’s
  config once and pass that socket path to clients explicitly: newer OpenSSH includes the jump
  host in `%C`, and the client’s `ProxyCommand=false` otherwise changes the hash.
  OpenSSH suppresses its proxy subprocess’s stderr when `ControlPersist` is enabled; the app
  preserves the parent SSH transport diagnostic, which can be less specific than the proxy’s error.
- **Closing** runs `ssh -O exit`, regardless of whether the CLI or the app started the master, so
  `ControlPersist=yes` masters are never orphaned.
- ssh is run with the local login-shell environment from `electron/login-shell-environment.cjs` so
  `PATH` and `SSH_AUTH_SOCK` match the user's terminal when the app is launched from Finder.

### Connect sequence

1. Establish or adopt the master.
2. Read `$SHELL` to choose the escaping dialect (below). Unsupported shells fail with
   `UnsupportedRemoteShellError`.
3. Capture the remote login environment once with `$SHELL -lc 'env -0'`, mirroring what
   `login-shell-environment.cjs` does locally. Non-interactive SSH sessions do not source the
   user's profile, so this is what makes `claude`, `codex` and API keys from `.zshrc` available.
4. Verify `git` resolves on the remote `PATH`, otherwise `RemoteCommandMissingError`.

### Escaping

ssh joins the remote command into one string that the remote login shell parses. Escaping has two
layers:

1. **Inner: a POSIX `sh` script.** Every argument is single-quoted (`'` becomes `'\''`).
   Environment variables are set with `env K=V`. Example:

   ```sh
   cd '/home/me/app' && exec env GIT_INDEX_FILE='/tmp/x/index' git -c core.quotePath=off diff --cached -- 'it'\''s a file.ts'
   ```

2. **Outer: `exec /bin/sh -c <inner>`**, with `<inner>` quoted for the login shell's dialect:
   - `sh`, `bash`, `zsh`, `dash`, `ksh`: POSIX single quotes.
   - `fish`: single quotes with `\` and `'` escaped as `\\` and `\'`, because fish treats
     backslashes inside single quotes as escapes (this matters for `git grep` patterns like `\b`).
   - Anything else (`csh`, `tcsh`, `nu`, ...): rejected with `UnsupportedRemoteShellError`.

Arguments must not contain NUL bytes; the quoter asserts this. NUL-separated payloads already go
over stdin.

### Operations

- `exec`: inner script runs the command with stdin/stdout piped as binary-safe Buffers.
- `lstat`: a script using `test -L/-d/-f/-x` and `wc -c` (not `stat`, whose flags differ between
  GNU and BSD).
- `lstatMany` / `readFiles`: one round trip for many paths with length-prefixed framing on stdout.
  Working-tree status (up to 1000 initial untracked items) uses these on both hosts; `LocalHost`
  loops.
- `readFile`: `cat -- <path>`. `readFileTail`: `tail -c <n> -- <path>`. `readlink`:
  `readlink -- <path>`. `readdir`: a `for` loop over the directory printing type and NUL-terminated
  names.
- `writeFile`: `cat > <path>` with contents on stdin, matching today's in-place write.
- `mkdtemp`: `mktemp -d`. `rm`: `rm -f` / `rm -rf --`.
- `spawn`: streaming. `pty: true` uses `ssh -tt` (only for commit hook output).
- **Cancellation**: for `spawn`, the inner script prints a PID marker line on stderr (on stdout
  for `pty: true`, where the streams are merged) and then `exec`s the command. `SshHost` strips the
  marker before exposing the stream. `kill()` closes the local client and runs `kill -TERM <pid>`
  over a separate channel, because closing the local ssh client does not reliably stop the remote
  process. `exec` calls with a `signal` use the same mechanism.
- **Concurrency**: at most 8 channels in flight per host, below sshd's default `MaxSessions=10`.
  Further requests queue.

## Feature behavior on a remote host

| Feature                                                         | Behavior                                                                                                                                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status, diffs, commit/branch/compare views, history             | Git via `host.exec`; working-tree and untracked contents and images via `host.lstatMany` / `host.readFiles`.                                                                      |
| Live refresh (`repository-watcher.cjs`)                         | Same polling (2.5s focused, 10s visible, 30s hidden) through `host.exec`; self-write checks via `host.lstat`. Pauses while disconnected and resumes after reconnect.              |
| Definition search                                               | `git grep` via `host.spawn` with the existing timeout and abort, using PID-based cancellation.                                                                                    |
| Generated-file detection                                        | Temporary `GIT_INDEX_FILE` from `host.mkdtemp()`, removed afterwards.                                                                                                             |
| Save file edits                                                 | `host.writeFile`.                                                                                                                                                                 |
| Stage and commit (`walkthrough-commit.cjs`)                     | `git add` via `host.exec`. Commit message passed with `commit -F -` over stdin instead of a local temp file (for both hosts). Hook output streamed via `host.spawn({pty: true})`. |
| Walkthroughs                                                    | Agent runs on the remote host (see below).                                                                                                                                        |
| Session context (`~/.claude`, `~/.codex` transcripts)           | Read through the host with `readdir` and `readFileTail`; home, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` come from the remote environment.                                             |
| `--walkthrough-context <file>` CLI flag                         | Stays a local file.                                                                                                                                                               |
| Walkthrough cache, viewed state, comments, plan reviews, config | Local, keyed by `host.id` + `repoPath`.                                                                                                                                           |
| PR/MR review, Open in Editor, Show in Folder                    | Hidden for remote repositories.                                                                                                                                                   |

### Walkthroughs on the remote

- Command resolvers (`getClaudeCommand`, `getCodexCommand`, opencode, pi) take `host` and use
  `host.resolveCommand` against the remote `PATH`.
- Runners call `host.spawn(command, args, {cwd: repoPath, env: await host.getEnvironment()})`
  through the existing `AgentCommandTransport` seam. No pty, so JSON streams are byte-clean.
- Codex's `--output-schema` and `--output-last-message` files live in `host.mkdtemp()`.
- Backend detection runs per host. If the configured backend is not installed on the remote, the
  error names the command and host (for example, "claude isn't installed on devbox"); there is no
  silent fallback to another backend.
- Timeouts kill the remote agent through PID-based cancellation.

## Entry points and UI

### CLI

Usage is unchanged: `codiff [options] [<ref> | <pr> | <url>] [path]`. `[path]` may be remote:

- `ssh://devbox/home/me/app` is always remote.
- `devbox:~/app` and `devbox:/srv/app` are remote when the part before the first `:` contains no
  `/` and the whole argument is not an existing local path (the scp/git rule). Local paths
  containing a colon can be written as `./weird:name`.

Sequence: parse arguments, establish or adopt the master in the terminal, resolve `~` and the
repository toplevel, classify refs through the host (`isBranchRef` / `isCommitRef` become async),
then hand `{hostId, repoPath, source}` to the app using the existing launch handoff.

`--share` and headless walkthrough sharing work for remote targets.

### App

- File menu: **Open Remote Repository...** opens a dialog following the `OpenReviewSourceDialog`
  pattern: a single `host:path` field (placeholder `devbox:~/src/app`) plus recently opened
  remotes stored in config next to `lastRepositoryPath`.
- Window title and top bar show `devbox: ~/src/app` for remote repositories.
- On `HostDisconnectedError`, a banner reads "Lost connection to devbox. Reconnect". The last
  loaded diff stays visible. Save, commit, walkthrough and refresh are disabled until reconnect.
- PR/MR actions, Open in Editor and Show in Folder are hidden for remote repositories.

### Errors

| Error                         | Cause                                                        | Message                                                                      |
| ----------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `HostAuthRequiredError`       | `BatchMode` hit an authentication prompt                     | "devbox needs interactive login. Run `codiff devbox:~/app` from a terminal." |
| `HostUnreachableError`        | ssh exit 255 with connect timeout, DNS or refused connection | ssh's stderr verbatim                                                        |
| `HostDisconnectedError`       | master died and the fallback connection also failed          | Disconnected banner                                                          |
| `UnsupportedRemoteShellError` | login shell is not POSIX or fish                             | "Codiff needs a POSIX or fish login shell on devbox"                         |
| `RemoteCommandMissingError`   | `git` or the agent binary is not on the remote `PATH`        | Names the command and the host                                               |

A non-zero git exit is not an SSH failure and keeps today's handling. Exit status 255 is ambiguous
(ssh failure or a command that exited 255), so the host runs `-O check` before classifying it.

## Testing

1. **Escaping unit tests**: a table of dangerous inputs (spaces, `'`, `"`, `\`, `$`, backticks,
   globs, `!`, newlines, leading `-`, unicode, empty string) plus property-based random strings.
   Each runs through real `sh`, `bash`, `zsh` and `fish` (skipped when not installed) and asserts
   the spawned process receives argv byte-for-byte. POSIX and fish quoting are tested separately.
2. **Host contract suite**: one shared suite for every `RepositoryHost` method and typed error,
   run against `LocalHost` always and against `SshHost` connected to a throwaway `sshd` started by
   the test on a random localhost port (temporary host key, `authorized_keys` and config, no root;
   skipped when `sshd` is missing). CI's Linux job installs `openssh-server` so it always runs.
3. **Existing git-state tests over both hosts**: status, diffs, commits, comparisons, generated
   files, definition search and walkthrough commit tests take a `host` fixture and run against
   `LocalHost` and `SshHost(localhost)`.
4. **Failure modes** against the test `sshd`: killing the master mid-session falls back and
   respawns; failed fallback raises `HostDisconnectedError`; disabled key auth raises
   `HostAuthRequiredError`; a command exiting 255 is not reported as an SSH failure; aborted
   `git grep` and agent spawns leave no remote process (`kill -0`); a csh `$SHELL` raises
   `UnsupportedRemoteShellError`.
5. **Guardrail**: a lint rule or require-scan test forbids `node:fs`, `node:child_process` and
   `node-pty` in `electron/git-state/**`, the repository watcher, definition search, generated
   files, walkthrough commit, session-context readers and agent runners. Only host implementations
   may use them.
6. **Performance**: extend `core/__tests__/git-state.bench.ts` to load status for a repository
   with 1000 untracked files over `SshHost(localhost)`. Target: within about 2x of local.
7. **Manual checklist before release**: fish login shell on the remote, 1Password SSH agent,
   `ProxyJump` host, password auth through the CLI, laptop sleep then reconnect, Claude and Codex
   walkthroughs running remotely.

## Delivery phases

1. **Introduce `RepositoryHost` and `LocalHost`; thread `host` everywhere.** No behavior change.
   Includes converting the synchronous git call sites to async, switching commits to `-F -`, adding
   `lstatMany` / `readFiles`, the guardrail lint rule, and updating the existing tests to pass a
   `LocalHost`. Verified by the existing test suite.
2. **`SshHost` transport**: escaping, master management, operations, cancellation, concurrency,
   typed errors, test `sshd` harness, contract suite and failure-mode tests.
3. **Entry points**: CLI remote target parsing and terminal master setup, launch handoff, Open
   Remote Repository dialog, recents, title indicator, disconnected banner, hiding unsupported
   actions.
4. **Remote walkthroughs**: remote environment capture, command resolution, agent runners and
   session-context readers through the host, per-host backend detection. Update
   `bin/walkthrough-guide.md` if walkthrough behavior visible to agents changes.
5. **Docs and benchmarks**: README section on remote repositories, benchmark, manual checklist.
