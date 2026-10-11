# SSH Remote Phase 5 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Steps use checkbox syntax.

**Goal:** Complete the approved local SSH implementation, close deferred local review items, measure status performance and document release validation.
**Architecture:** Keep system SSH/RepositoryHost unchanged. Add CLI stream progress to the existing OpenCode runner, fix menu ordering and completion/state validation debt, extend the existing Git benchmark, and publish a single overall progress record.
**Tech Stack:** Electron CommonJS, React/TypeScript, system OpenSSH, vite-plus benchmark runner.
**Spec:** docs/superpowers/specs/2026-10-10-ssh-remote-repositories-design.md

## Global Constraints

- Continue on current main per standing no-worktree preference. No push, CI dispatch against stale remote code, release publication or merge.
- Remote execution uses the shared system-SSH host; local context files remain local. Preserve local agent paths and parsing semantics.
- Benchmark1000 untracked files against LocalHost and SshHost(localhost), excluding SSH setup from samples; report measured ratio against the approximately2x target.
- Document external manual gates accurately: 1Password agent, real password terminal authentication, laptop sleep/reconnect and provider-backed walkthroughs cannot be marked tested without evidence.
- Run vp check --fix then vpr build after code changes. TypeScript baseline278 (no per-file increase); start with two failing tests: Git process count16 vs14 and fish source-flag refs.

## Review Focus

- OpenCode events split across UTF-8 chunks/newlines must report progress before process close, ignore malformed non-text events and preserve final output.
- Menu arrow/Home/End navigation must follow visible item order with and without remote action.
- Identical HOME/config/session paths on distinct hosts must preserve each host's own transcript.
- Benchmarks must use equivalent1000-file fixtures, count all files, reuse one SSH master and clean up processes/directories on failure.
- README examples must match actual target parsing, authentication ownership, restrictions and remote agent selection; overall progress must distinguish local completion from external release gates.

### Task 1: Close deferred local review items

**Files:** electron/opencode.cjs; electron/**tests**/remote-agent.test.ts; electron/**tests**/remote-session-context.test.ts; core/app/components/OpenReviewSourceMenu.tsx; core/**tests**/OpenReviewSourceMenu.test.tsx.
**Interfaces:** Existing onProgress(phase) callback; existing host-bound run and session readers; existing menu item refs.

- [x] Add a remote OpenCode test with split Unicode JSON events and delayed close, assert response-received before close and unchanged structured output; run RED.
- [x] Incrementally frame/decode CLI output and notify on nonempty text events. Add identical-path fixtures on both virtual hosts.
- [x] Add menu keyboard traversal with remote action, watch RED; assign refs in visual order and run all affected tests GREEN.
- [x] Check/build; commit explicit paths locally.

### Task 2: Clear validation debt

**Files:** electron/git-state.cjs and relevant git-state helpers; bin/completions.js; core/**tests**/git-state.test.ts; core/**tests**/codiff-completions.test.ts.
**Interfaces:** readWalkthroughRepositoryState(host,path,source?,options?); generated fish completion script.

- [x] Reproduce both baseline failures and inspect actual Git trace/commandline tokens before changing behavior.
- [x] Remove redundant implicit-walkthrough Git probes without weakening the14-process assertion; correct fish flag-value versus trailing-path predicates without evaluating ref names.
- [x] Run Git state and all shell completion suites GREEN, including the Git state suite over SSH. Check/build; commit explicit paths.

### Task 3: Add and run the SSH status benchmark

**Files:** core/**tests**/git-state.bench.ts.
**Interfaces:** readRepositoryState(host,repo); startTestSshd/connectSshHost and existing bench context API.

- [x] Add equivalent local/SSH status benchmarks for1000 untracked files; assert exactly1000 returned, reuse warmed host/master and finally dispose fixtures.
- [x] Run vp test bench --run core/**tests**/git-state.bench.ts; record local/SSH medians and ratio. If above approximately2x, profile command counts/batching and fix the measured cause with regression coverage.
- [x] Check/build and commit benchmark/performance changes explicitly.

### Task 4: Documentation and overall progress

**Files:** README.md; docs/superpowers/ssh-remote-validation.md; docs/superpowers/ssh-remote-progress.md; design spec status and phase ledgers.

- [x] Add README examples for GUI/CLI targets, refs/ports, remote agents/session/context/sharing, reconnect and supported platform/tooling restrictions. Verify each against code/tests.
- [x] Write a reproducible benchmark command/results section and manual release checklist, identifying automated evidence versus checks not performed.
- [x] Create an overall progress table for Phases1–5 with commits, verification and external gates; link it from phase ledgers and design spec.

### Task 5: Final review, verification and local handoff

- [x] One fresh whole-phase review; fix Important/Critical once with RED→GREEN regressions, record rulings/minors.
- [x] Full vp test, nine repository suites over SSH, benchmark, TypeScript baseline gate, vp check --fix then vpr build and git diff --check; aim for all local tests green.
- [x] Commit final docs/progress locally, preserve resumable ledgers, record accurate completion and external CI/manual release gates. No push.
