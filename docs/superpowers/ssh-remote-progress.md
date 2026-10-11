# SSH remote repositories: overall progress

All five implementation phases are complete locally as of October 11, 2026. Work stays on the
current branch and has not been pushed. External release validation remains in the
[release checklist](ssh-remote-validation.md#external-release-checklist).

| Phase               | Local result                                                                                                                                                                               | Commit / plan                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 1: host abstraction | RepositoryHost, local adapter and host-based repository operations implemented before Phase 2.                                                                                             | [Phase 1 plan](plans/2026-10-10-ssh-remote-phase-1-repository-host.md)                             |
| 2: system SSH host  | Multiplexed transport, shell/stat negotiation, bounded filesystem batches and lifecycle/diagnostic fixes complete.                                                                         | Follow-up fixes `b281579`; [Phase 2 plan](plans/2026-10-10-ssh-remote-phase-2-ssh-host.md)         |
| 3: entry points     | CLI targets and terminal authentication, shared host ownership, GUI opening, recents, host title, disconnect guards and reconnect complete.                                                | `5493ce1`, `4bad94a`; [Phase 3 plan](plans/2026-10-10-ssh-remote-phase-3-entry-points.md)          |
| 4: walkthroughs     | Remote login environment, host-bound agents and session readers, remote temp/output cleanup and remote walkthrough sharing complete.                                                       | `b86f693`; [Phase 4 plan](plans/2026-10-10-ssh-remote-phase-4-walkthroughs.md)                     |
| 5: completion       | Incremental OpenCode progress/UTF-8 decoding, identical-path host isolation tests, menu order, fish completion and Git process-budget fixes, optimized status benchmark and docs complete. | `58c84bf`, `1633d2b`, `c1e81f0`; [Phase 5 plan](plans/2026-10-11-ssh-remote-phase-5-completion.md) |

## Final validation

- Full root suite: 131 suites passed; 1,393 tests passed and one skipped.
- Repository operations over genuine SSH: all nine suites and 164 tests passed.
- Sharing integration: eight tests passed.
- TypeScript: 278 existing errors, with no per-file increase.
- Formatting/lint, local build and `git diff --check`: passed.
- Fresh whole-phase review: no Critical or Important findings; the minor prerequisite omission
  was corrected in the documentation.

The earlier Git process-budget and fish completion failures now pass. The 1,000-file benchmark
measures LocalHost 78.58 ms and SshHost 159.29 ms (2.027×) after optimization, versus 5,501.06 ms
SSH before optimization. See the
[benchmark method and results](ssh-remote-validation.md#reproduce-the-performance-benchmark).

The TypeScript gate uses the Phase 4 completion baseline of 278 existing errors and checks each
file for increases. A successful gate does not mean the whole repository is TypeScript-clean.
Ignored per-phase `.superpowers/sdd/.../progress.md` ledgers retain detailed local test evidence
and handoff history. This tracked document is the canonical overall progress record.
