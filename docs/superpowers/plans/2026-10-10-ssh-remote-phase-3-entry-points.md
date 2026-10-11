# SSH Remote Phase 3 Entry Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Open SSH repositories from the terminal and app, preserve host identity, and show connection state with a reconnect action.

**Architecture:** A startup-owned host registry shares one SSH host per destination and port. Entry points resolve remote paths and refs before handing a host and absolute repository path to existing repository functions. Renderer state remains local and uses host-qualified keys with unchanged local keys.

**Tech Stack:** Electron CommonJS, Node system SSH, React/TypeScript, vite-plus tests.

**Spec:** `docs/superpowers/specs/2026-10-10-ssh-remote-repositories-design.md`

## Global Constraints

- Use system SSH and the user's SSH config; no remote helper or bundled SSH library.
- Support macOS and Linux remotes with POSIX or fish login shells. Remote repositories are unavailable on Windows.
- Clients use the persistent master only; failed operations are not retried automatically.
- Pass hosts explicitly below entry points; no global host lookup in repository code.
- Preserve local persisted keys byte-for-byte. Remote keys include host identity and repository path.
- Hide PR/MR, editor and folder actions for remote repositories.
- Remain on the existing main checkout under the recorded user preference. Do not push, per the user's latest instruction.
- Run `vp check --fix` followed by `vpr build` after code changes. Record the existing two test failures and 282-error TypeScript baseline separately from regressions.
- Remote walkthrough environment and session-context work belongs to Phase 4. Until then reject unsupported remote agent/local-file workflows explicitly.

## Review Focus

- An existing local path containing a colon wins over SCP syntax; explicit ssh URLs never become local paths (Task 2).
- Several windows or simultaneous opens of one host share a connection, and a failed open releases its lease (Task 3).
- A lost master preserves the last diff and cannot silently run an operation on the local filesystem (Tasks 1, 4, 5).
- Queued spawn/PTY work, cancellation before PID announcement, and close during recovery leave no remote process (Task 1).
- The same repository path on local and two remote hosts never shares windows or persisted review state (Task 4).

### Task 1: Make the transport ready for entry points

**Files:** Modify `electron/host/ssh-connection.cjs`, `electron/host/ssh-host.cjs`, `electron/host/repository-host.cjs`; test existing SSH suites.

**Interfaces:** Connection options add `port?: number`, asynchronous `getLocalEnvironment`, and `interactive?: boolean`. SSH host adds `getConnectionState(): 'connected' | 'disconnected' | 'closed'`, `onConnectionState(listener): () => void`, `reconnect(): Promise<void>`.

- [x] Add failing tests for explicit port, async environment, shared interactive master options, close rejection/process cleanup, reconnect notification, spawn exit 255 and unsupported stat.
- [x] Run those tests and record RED.
- [x] Apply one shared session limiter to exec, spawn and PTY; reserve a bounded cancellation channel. Keep slots until children close even when the caller aborts. Close cancels queued and active work before exiting the master; reject work after close. Preserve ChildProcess kill signal/killed semantics. Detect GNU/BSD stat using the actual required format.
- [x] Run SSH contract/failure/connection suites, TypeScript gate, check and build; record GREEN and commit explicit paths.

### Task 2: Parse and resolve remote repository targets

**Files:** Create `electron/host/repository-target.cjs` and its test; modify `bin/arguments.js`, `bin/codiff.js`, `electron/main/command-line.cjs` and their tests.

**Interfaces:** `parseRepositoryTarget(value, {exists?})` returns `{alias, port?, path, hostId}` or null. `resolveRemoteRepository(host, path)` expands only `~`/`~/` using remote HOME, rejects other relative paths, resolves Git toplevel through host. `resolveRemoteSource(host, repositoryPath, {candidate?, range?})` classifies refs asynchronously. CLI handoff uses `CODIFF_REMOTE_TARGET` plus resolved `CODIFF_REPOSITORY_PATH` and existing source fields.

- [x] Add failing tests for SCP/URI/user/port, local colon precedence, malformed URL/option injection, remote HOME with spaces, remote branch/commit/range classification.
- [x] Run focused tests and record RED.
- [x] Recognize remote targets before local ref/path classification; preserve local parsing. Connect interactively in the CLI with shared master setup, then resolve paths/refs. Reject remote PR/plan and Phase 4 agent workflows before local access. Handoff the canonical target and resolved path. App CLI parsing preserves remote targets without `path.resolve` or local Git probes.
- [x] Run target/argument/command-line/SSH tests, check and build; commit explicit paths.

### Task 3: Own shared remote hosts

**Files:** Create `electron/host/host-registry.cjs` and tests; use existing `electron/login-shell-environment.cjs`.

**Interfaces:** `createHostRegistry({localHost, connect?, getLocalEnvironment?})` supplies `acquire(target): Promise<{host, release(): Promise<void>}>` and `close(): Promise<void>`. Acquisition is single-flight; refcounts include pending opens. Last release closes the host. Close rejects new acquisition and drains pending connections.

- [x] Add failing tests for concurrent opens, distinct ports, failed connect retry, last release, quit during connect and environment precedence.
- [x] Run focused tests and record RED.
- [x] Implement registry with async login environment merged under current process environment; share only identical destination/port identities.
- [x] Run registry tests, check and build; commit explicit paths.

### Task 4: Wire host identity and app launch lifecycle

**Files:** Modify `electron/main.cjs`, `electron/window-identity.cjs`, `electron/window-repositories.cjs`, `electron/main/window-launch-queue.cjs`, config and local persistence consumers; add focused identity/lifecycle tests.

**Interfaces:** Host-qualified keys preserve local bytes. Each window owns a registry lease and remote target metadata. IPC exposes repository host info and reconnect; missing window context throws. Launch queues report failures and allow enough time for the 30-second master setup.

- [x] Add failing tests for local/remote/two-host identity, strict missing context, launch pending state/timeout, and host-qualified persisted state.
- [x] Run focused tests and record RED.
- [x] Route startup, single-instance handoff and remote dialog opens through registry; resolve remote roots before window creation. Release on reuse, failed opens and close. Close registry at quit; prevent pending launches from triggering early quit. Key watcher/cache/review state by host; retain local last path and remote recents separately. Guard local-only IPC operations for remotes.
- [x] Run affected tests plus repository-over-SSH suites, TypeScript gate, check and build; commit explicit paths.

### Task 5: Add remote UI and reconnect behavior

**Files:** Modify renderer/preload API types, `core/App.tsx`, top bar and action components; create remote dialog following the existing review-source dialog.

**Interfaces:** API provides `getRepositoryHost`, `openRemoteRepository`, `reconnectRepositoryHost`, `onRepositoryHostChanged`, `onOpenRemoteRepositoryRequest`. Host info carries id, label, target, state and recent targets.

- [x] Add focused UI tests where the existing component harness supports them; pin remote capabilities and state keys in unit tests.
- [x] Add File menu command, one-field dialog (`devbox:~/src/app`) and recents, host title indicator, lost-connection banner and reconnect action. Keep loaded diffs; disable remote writes/commit/refresh/walkthrough while disconnected. Hide PR/MR/editor/folder and unsupported local-file workflows.
- [x] Run affected tests, check and build; commit explicit paths.

### Task 6: Review and verify Phase 3

- [x] Request one fresh whole-phase code review under the native execution skill; resolve material findings and record deferrals.
- [x] Run full `vp test`, repository-over-SSH suites, TypeScript baseline gate, `vp check --fix`, then `vpr build`. Record results and commit remaining changes.
- [x] Update the progress ledger with completion and concrete Phase 4 next steps. Do not push or dispatch CI; Ubuntu validation remains deferred by the user.

## Local completion evidence

- Foundations committed as `5493ce1`; app identity, UI and reviewed lifecycle fixes completed locally. No push or CI dispatch.
- Fresh whole-phase review: three Important findings fixed with regressions (reconnect racing close, canceled quit closing hosts, failed CLI handoff leaking a master); no Critical findings.
- Full suite: 1,361 passed, 1 skipped; two unchanged baseline failures (bounded Git process count 16 vs 14 and fish source-flag completion).
- SSH host suites: 117/117 passed. Nine repository suites over SSH: 163 passed, with only the same bounded-process baseline failure.
- TypeScript baseline gate: 281 errors vs 282, no per-file increase. `vp check --fix` and `vpr build` passed; built files refreshed.
- Built renderer visually checked with a mocked preload: remote title, preserved nonempty diff while disconnected, reconnect, remote dialog/recents and submission. Only preview favicon 404 in console.
- Deferred minor: remote/folder source-menu keyboard ordering differs from visual ordering.
- Next: Phase 4 remote environment capture, command resolution, runners/session readers and per-host agent behavior; then Phase 5 docs and benchmark/manual checklist. Ubuntu CI remains deferred by the no-push instruction.
