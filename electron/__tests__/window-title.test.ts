import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
type WindowRepositoryState = {
  root: string;
  hostLabel?: string;
  source:
    | { type: 'working-tree' }
    | { ref: string; type: 'branch-working-tree' }
    | { ref: string; type: 'commit' }
    | { number?: number; type: 'pull-request'; url: string }
    | { base: string; head: string; symmetric: boolean; type: 'range' };
};

const { getPlanWindowTitle, getRepositoryWindowTitle, restoreRepositoryWindowTitleAfterLoad } =
  require('../window-title.cjs') as {
    getPlanWindowTitle: (planFile: string) => string;
    getRepositoryWindowTitle: (state: WindowRepositoryState) => string;
    restoreRepositoryWindowTitleAfterLoad: (
      target: { isDestroyed: () => boolean; setTitle: (title: string) => void },
      initialRepositoryState: Promise<WindowRepositoryState> | null,
    ) => Promise<void>;
  };

const root = '/Users/reviewer/Documents/GitHub/MyCoolRepo';

test('titles windows with the repository and selected source', () => {
  expect(getRepositoryWindowTitle({ root, source: { type: 'working-tree' } })).toBe(
    'MyCoolRepo · Codiff',
  );
  expect(
    getRepositoryWindowTitle({
      root,
      source: {
        number: 1337,
        type: 'pull-request',
        url: 'https://github.com/framer/MyCoolRepo/pull/1337',
      },
    }),
  ).toBe('MyCoolRepo/1337 · Codiff');
  expect(
    getRepositoryWindowTitle({
      root,
      source: { type: 'pull-request', url: 'https://github.com/framer/MyCoolRepo/pull/1338' },
    }),
  ).toBe('MyCoolRepo/1338 · Codiff');
  expect(
    getRepositoryWindowTitle({
      root,
      source: { ref: 'feature/new-title', type: 'branch-working-tree' },
    }),
  ).toBe('MyCoolRepo/feature/new-title · Codiff');
  expect(getRepositoryWindowTitle({ root, source: { ref: 'a1b2c3d4', type: 'commit' } })).toBe(
    'MyCoolRepo/a1b2c3d · Codiff',
  );
  expect(
    getRepositoryWindowTitle({
      root,
      source: { base: 'main', head: 'feature', symmetric: true, type: 'range' },
    }),
  ).toBe('MyCoolRepo/main...feature · Codiff');
});

test('titles plan windows like web pages', () => {
  expect(getPlanWindowTitle('/tmp/implementation-plan.md')).toBe('implementation-plan.md · Codiff');
});

test('restores the repository title after the renderer loads', async () => {
  let title = '';
  const target = {
    isDestroyed: () => false,
    setTitle: (nextTitle: string) => {
      title = nextTitle;
    },
  };
  const state = { root, source: { type: 'working-tree' } } as const;

  target.setTitle(getRepositoryWindowTitle(state));
  target.setTitle('Codiff');
  await restoreRepositoryWindowTitleAfterLoad(target, Promise.resolve(state));

  expect(title).toBe('MyCoolRepo · Codiff');
});

test('remote titles identify the host and repository path', () => {
  expect(
    getRepositoryWindowTitle({
      root: '/srv/app',
      hostLabel: 'devbox',
      source: { type: 'working-tree' },
    }),
  ).toBe('devbox: /srv/app · Codiff');
});
