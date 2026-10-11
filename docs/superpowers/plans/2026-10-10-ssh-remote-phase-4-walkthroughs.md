# SSH Remote Phase 4 Walkthroughs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox syntax.

**Goal:** Run walkthroughs and linked-session context on the repository's host, including remote headless sharing.
**Architecture:** Extend RepositoryHost with bounded reads, directory listings, cached login environment and command resolution. Bind backend execution and session readers explicitly to a host using the existing command transport seam. Local UI/config/cache/files remain local; remote agent data and Codex temporary outputs live remotely.
**Tech Stack:** Electron CommonJS, system SSH, React/TypeScript, vite-plus.
**Spec:** docs/superpowers/specs/2026-10-10-ssh-remote-repositories-design.md

## Global Constraints

- Reuse system SSH and the host owned by the registry; no helper installation, no per-operation connections or silent local/backend fallback.
- Preserve existing local behavior and byte-identical local cache keys. Configured remote backend missing: name command and host.
- Remote environment supplies HOME, PATH, credentials and session directories; laptop environment never overrides remote values.
- POSIX and fish login shells supported. No remote HTTP port exposed/tunneled; remote OpenCode uses CLI stream rather than local serve HTTP.
- --context and --walkthrough-file refer to local files. Remote plan/PR/editor/folder workflows remain unsupported.
- Native execution on current main checkout per standing preference; do not push or dispatch CI.
- After code changes run vp check --fix then vpr build. Baseline: 281 TypeScript errors, two known test failures (Git count 16 vs 14 and fish source-flag completion).

## Review Focus

- Two hosts with the same HOME/repo/session ID must never read one another's transcripts or reuse cached environments (Tasks 1–3).
- Login startup noise, spaces/newlines and secrets in environment values must remain byte-correct without laptop overrides (Task 1).
- Codex schema/output directory lives remotely and is removed on success, error and timeout, including setup errors (Task 3).
- Agents that ignore TERM must not survive timeout or keep transport slots/remote temp artifacts alive (Task 3).
- Disconnected remote walkthrough actions stay disabled; CLI generated/file sharing uses remote repository and local context files (Task 4).

### Task 1: Host environment and bounded filesystem operations

**Files:** electron/host/repository-host.cjs, local-host.cjs, ssh-host.cjs; host/environment.cjs; login-shell-environment.cjs; host contract/failure tests.
**Interfaces:** getEnvironment(): Promise<Readonly<Record<string,string>>>; resolveCommand(name:string): Promise<string|null>; readdir(path): Promise<Array<{name:string,type:HostFileType}>>; readFileTail(path,maxBytes): Promise<Buffer>.

- [x] Add contract assertions for hidden/unicode/symlink entries and bounded tail incl zero/invalid limits; add remote environment isolation/noise/cache and PATH-only CLI tests. Run suites; expect RED missing methods.
- [x] Implement local operations with existing login environment precedence, remote cached interactive login env with marker/NUL parsing and 10s cancellation; resolve via captured PATH. Remote directory/tail use quoted POSIX scripts and existing limiter.
- [x] Run host suites, TypeScript baseline gate, check and build; expect GREEN, commit explicit paths.

### Task 2: Session context on its own host

**Files:** session-context-shared.cjs, claude/codex/pi/opencode-session-context.cjs; existing session suites and new remote-session tests.
**Interfaces:** read*SessionContext(host,sessionId): Promise<WalkthroughContext|null>; shared bounded read accepts host first.

- [x] Test remote HOME/config overrides, identical session IDs on distinct hosts, bounded last-line behavior and OpenCode host export. Run; expect RED local filesystem lookup/signature mismatch.
- [x] Remove direct fs/os/process lookup from session readers; scan host listings (20,000 cap) with remote POSIX/local native joins and host tail (16MiB cap). OpenCode export redirects to a host temporary file, timeout15s/SIGKILL, size cap16MiB and finally removal.
- [x] Run all session context tests, check/build; expect GREEN, commit explicit paths.

### Task 3: Bind agent execution to RepositoryHost

**Files:** agent.cjs, agent-command.cjs, claude/codex/opencode/pi.cjs; backend tests and remote-agent tests.
**Interfaces:** getAgentForHost(host,backendId): Agent; metadata stays from getAgent, bound run resolves host CLI/env and passes repositoryHost/commandTransport; readSessionContext binds Task2 readers. isAvailable supports async host check; no fallback backend.

- [x] Test missing remote command names host/code, remote env excludes laptop secret, remote schema/output cleanup, genuine SSH streaming and cancellation. Run; expect RED unbound local execution.
- [x] Add host binding with configured command overrides from host env, host.spawn/cwd/env. Backend environment uses host when bound. Codex exec temp lifecycle uses host and finally encompasses setup. Remote Codex app-server stdio may stay enabled; remote OpenCode uses CLI path and reports response progress from CLI events. Timeout kills remote with SIGKILL (local behavior preserved).
- [x] Run backend/session/remote SSH tests, TypeScript gate, check/build; expect GREEN, commit explicit paths.

### Task 4: Enable remote workflows in entry points/UI

**Files:** electron/main.cjs, main/repository-launch.cjs, headless-walkthrough-share.cjs; bin/codiff.js, walkthrough-guide.md; core/App.tsx and useAppCommands.ts; affected tests.
**Interfaces:** All walkthrough/review/commit-message IPCs select getAgentForHost(windowHost,configuredBackend). Headless sharing accepts same host. Remote returned state carries hostId/hostLabel.

- [x] Test accepted remote walkthrough/context/file launches (plan/PR still reject), remote generation UI enabled while connected/disabled on loss, CLI flags and host-linked sharing. Run; expect RED Phase3 guards.
- [x] Lift Phase3 agent/file guards only, retain local Markdown editing/editor/PR restrictions. Route bound agents and host-qualified initial/generated state, enable walkthrough/Ask actions when connected. CLI share uses remote host then closes it; generated/file context stays local. Update walkthrough guide.
- [x] Run affected UI/CLI/headless suites, check/build; expect GREEN, commit explicit paths.

### Task 5: Review and final gates

- [x] One fresh whole-phase review, fix Important/Critical once with RED→GREEN regressions; record minors/rulings.
- [x] Full vp test, host/repository suites over SSH, TypeScript baseline gate, vp check --fix then vpr build; no new failures.
- [x] Record local completion/progress/next Phase5 docs+benchmark. Keep ledger for resume and deferred CI. No push.

## Execution record

Tasks1–4 are implemented together as one host-binding change. A fresh review found three material defects in cancellation and connection-error handling; regressions reproduced each before the fixes. Remote OpenCode currently reports initial generation and final response; incremental CLI progress is deferred. The transcript-isolation fixture should additionally cover identical paths across hosts.

Local verification accepts only the two existing suite failures (Git process count16 vs14 and fish source-flag completion); Linux CI remains deferred under the no-push instruction. Detailed evidence and resumable status are in `.superpowers/sdd/2026-10-10-ssh-remote-phase-4-walkthroughs/progress.md`. Phase5 documentation and latency benchmarks are next.
