# SSH remote repository validation

Local implementation is complete. This record distinguishes automated localhost coverage from
checks that require external machines, credentials, or CI. The implementation is included in this
fork's `v2.0.0` release; the benchmark and test counts below describe the October 11, 2026 checkpoint.

## Reproduce the performance benchmark

With dependencies installed and `sshd` available:

```bash
export PATH="$PWD/node_modules/.bin:$PATH"
vp test bench --run core/__tests__/git-state.bench.ts
```

The fixture contains one committed file and exactly 1,000 untracked files. LocalHost and SshHost
read the same directory and bytes on this macOS machine, with a persistent loopback SSH master.
SSH connection setup is excluded. Both paths are warmed before five measured iterations, and
all samples assert that exactly 1,000 untracked files were returned. Cleanup closes the master,
stops the disposable sshd and removes the repository. Without `sshd`, the SSH comparison is skipped.
The command also runs the existing 160-file commit benchmark and writes raw medians to
`.superpowers/benchmarks/ssh-status.json`.

| Implementation                             | Local median |  SSH median | SSH/local |
| ------------------------------------------ | -----------: | ----------: | --------: |
| Original shell reader                      |     85.30 ms | 5,501.06 ms |    64.49× |
| Optional Perl batch reader, serial chunks  |     80.93 ms |   211.63 ms |    2.615× |
| Batch reader and concurrent bounded chunks |     78.58 ms |   159.29 ms |    2.027× |

Measured on October 11, 2026. This meets the approximately 2× localhost target. Five samples are
an indicative local measurement, not a WAN latency guarantee. Perl is used only when already
installed; the original POSIX fallback still works but does not have the same performance result.
All reads share the host's six-channel limit, including Git and agent commands. Results retain
input order even when chunks finish out of order. Tests cover both reader branches, binary and
empty files, symlinks, missing paths, directories, FIFOs and changing file sizes.

## Automated verification

Checkpoint results are recorded in [overall progress](ssh-remote-progress.md). Run the root suite
with `vp test` and the repository suites over SSH with:

```bash
CODIFF_TEST_HOST=ssh vp test \
  core/__tests__/git-state.test.ts \
  core/__tests__/git-files.test.ts \
  electron/__tests__/repository-watcher.test.ts \
  electron/__tests__/definition-search.test.ts \
  electron/__tests__/walkthrough-commit.test.ts \
  electron/__tests__/repository-file.test.ts \
  electron/__tests__/window-identity.test.ts \
  electron/__tests__/review-source.test.ts \
  electron/__tests__/git-identity.test.ts
```

This matches the SSH suite selection in [CI](../../.github/workflows/test.yml). The fixture needs
OpenSSH client/server tools and uses disposable loopback connections rather than an existing host.

Run `vpr test:integration` to build and test sharing with local Miniflare and mocked GitHub requests.
Run `vp check --fix` followed by `vpr build` after code changes. The implementation checkpoint had
278 TypeScript errors and used a per-file no-increase gate; that historical count is not a fresh
validation result for the current branch.

Automated SSH fixtures cover real system SSH, master reuse and cleanup, a two-hop ProxyJump,
binary/path escaping, GNU/BSD stat parsing, disconnect/reconnect, channel limits, abort/timeout
process cleanup, all four agent CLI routes with test providers, and host-isolated session reads.
Fish shell quoting and completion parsing have automated coverage; that does not substitute for
a real fish login shell connection below.

## External release checklist

These checks have no recorded results here. Verify them against the commits being released:

- [ ] Linux CI against these exact commits, including the localhost sshd suites and benchmark.
- [ ] A remote whose login shell is fish: open, stage, commit and run a walkthrough.
- [ ] SSH authentication through a real 1Password SSH agent, including approval prompts.
- [ ] A real ProxyJump deployment using the user's SSH configuration.
- [ ] Password authentication through the terminal CLI followed by GUI connection reuse.
- [ ] Laptop sleep/network interruption followed by Reconnect and a successful write action.
- [ ] Real Claude and Codex remote walkthroughs with authenticated provider accounts.

The [test workflow](../../.github/workflows/test.yml) now includes the repository suites over SSH
on Linux. Record a passing run for the release commits before checking off Linux validation.
The manual checks need the corresponding remote setups and provider credentials; publishing
a release does not establish that these checks passed.
