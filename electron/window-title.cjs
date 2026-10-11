// @ts-check

const { basename } = require('node:path');
const { parseReviewUrl } = require('./review-source.cjs');

/** @typedef {Pick<import('../core/types.ts').RepositoryState, 'root' | 'source' | 'hostLabel'>} WindowRepositoryState */
/** @typedef {{isDestroyed: () => boolean, setTitle: (title: string) => void}} WindowTitleTarget */

/** @param {import('../core/types.ts').ReviewSource} source */
const getWindowSourceTitle = (source) =>
  source.type === 'working-tree'
    ? null
    : source.type === 'pull-request'
      ? String(source.number ?? parseReviewUrl(source.url)?.number ?? 'PR')
      : source.type === 'commit'
        ? source.ref.slice(0, 7)
        : source.type === 'range'
          ? `${source.base}${source.symmetric ? '...' : '..'}${source.head}`
          : source.ref;

/** @param {string} title */
const getCodiffWindowTitle = (title) => `${title} · Codiff`;

/** @param {string} planFile */
const getPlanWindowTitle = (planFile) => getCodiffWindowTitle(basename(planFile));

/**
 * @param {WindowRepositoryState} state
 */
const getRepositoryWindowTitle = (state) => {
  // Use the resolved source so aliases such as HEAD and a PR URL become the view the user opened.
  const sourceTitle = getWindowSourceTitle(state.source);
  return getCodiffWindowTitle(
    `${state.hostLabel ? `${state.hostLabel}: ${state.root}` : basename(state.root)}${sourceTitle ? `/${sourceTitle}` : ''}`,
  );
};

/**
 * @param {WindowTitleTarget} target
 * @param {Promise<WindowRepositoryState> | null | undefined} initialRepositoryState
 */
const restoreRepositoryWindowTitleAfterLoad = async (target, initialRepositoryState) => {
  if (!initialRepositoryState) {
    return;
  }
  const state = await initialRepositoryState;
  if (!target.isDestroyed()) {
    target.setTitle(getRepositoryWindowTitle(state));
  }
};

module.exports = {
  getPlanWindowTitle,
  getRepositoryWindowTitle,
  restoreRepositoryWindowTitleAfterLoad,
};
