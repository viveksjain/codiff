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
  'session-context-shared.cjs',
  'claude-session-context.cjs',
  'codex-session-context.cjs',
  'pi-session-context.cjs',
  'opencode-session-context.cjs',
];

const forbiddenModules = [
  'node:child_process',
  'node:fs',
  'node:fs/promises',
  'node:os',
  './pty.cjs',
  '../pty.cjs',
  'child_process',
  'fs',
  'fs/promises',
  'os',
  'node-pty',
  './host/local-host.cjs',
  '../host/local-host.cjs',
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
