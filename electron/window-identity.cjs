// @ts-check

const { realpathSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { getRepositoryKey } = require('./host/repository-identity.cjs');
const { git } = require('./git-state/common.cjs');
const { parseReviewUrl } = require('./review-source.cjs');

/**
 * @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../core/types.ts').CodiffLaunchOptions} CodiffLaunchOptions
 * @typedef {{key: string; repositoryRoot: string; sourceKey: string}} WindowIdentity
 * @typedef {{number: number; owner: string; repo: string}} ParsedPullRequest
 */

/** @param {string} path */
const getRealPath = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** @param {RepositoryHost} host @param {string} path */
const getHostRealPath = async (host, path) => {
  try {
    return await host.realpath(path);
  } catch {
    return path;
  }
};

/** @param {RepositoryHost} host @param {string} repositoryPath */
const resolveRepositoryRoot = async (host, repositoryPath) => {
  const resolvedPath = resolve(repositoryPath);
  try {
    return await getHostRealPath(
      host,
      (await git(host, resolvedPath, ['rev-parse', '--show-toplevel'])).trim(),
    );
  } catch {
    return getHostRealPath(host, resolvedPath);
  }
};

/** @param {RepositoryHost} host @param {string} repositoryRoot @param {string} ref */
const resolveCommitRef = async (host, repositoryRoot, ref) => {
  try {
    return (await git(host, repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`]))
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
};

/** @param {RepositoryHost} host @param {string} repositoryRoot */
const hasWorkingTreeChanges = async (host, repositoryRoot) => {
  try {
    return Boolean(
      await git(host, repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=normal',
      ]),
    );
  } catch {
    return false;
  }
};

/** @param {RepositoryHost} host @param {string} repositoryRoot @param {string} baseRef @param {string} headRef */
const resolveMergeBase = async (host, repositoryRoot, baseRef, headRef) => {
  try {
    return (await git(host, repositoryRoot, ['merge-base', baseRef, headRef])).trim().toLowerCase();
  } catch {
    return null;
  }
};

/** @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const getPullRequestSourceKey = (source) => {
  const review = parseReviewUrl(source.url);
  if (review?.provider === 'gitlab') {
    return `pull-request:gitlab:${review.host}/${review.projectPath.toLowerCase()}#${
      review.number
    }`;
  }
  const pullRequest =
    source.owner && source.repo && source.number
      ? {
          number: source.number,
          owner: source.owner,
          repo: source.repo,
        }
      : review?.provider === 'github'
        ? /** @type {ParsedPullRequest} */ ({
            number: review.number,
            owner: review.owner,
            repo: review.repo,
          })
        : null;

  return pullRequest
    ? `pull-request:${pullRequest.owner.toLowerCase()}/${pullRequest.repo.toLowerCase()}#${
        pullRequest.number
      }`
    : null;
};

/** @param {RepositoryHost} host @param {string} repositoryRoot @param {ReviewSource} [source] */
const getSourceKey = async (host, repositoryRoot, source = { type: 'working-tree' }) => {
  if (source.type === 'working-tree') {
    return 'working-tree';
  }

  if (source.type === 'commit') {
    if (source.github) return getResolvedSourceKey(source);
    const commit = await resolveCommitRef(host, repositoryRoot, source.ref);
    return commit ? `commit:${commit}` : null;
  }

  if (source.type === 'branch') {
    const head = await resolveCommitRef(host, repositoryRoot, 'HEAD');
    const target = await resolveCommitRef(host, repositoryRoot, source.ref);
    const nextBase =
      target && head ? await resolveMergeBase(host, repositoryRoot, target, head) : null;
    return nextBase && head ? `branch-diff:${source.ref}:${nextBase}:${head}` : null;
  }

  if (source.type === 'branch-diff') {
    const base = await resolveCommitRef(host, repositoryRoot, source.baseRef);
    const head = await resolveCommitRef(host, repositoryRoot, source.headRef);
    return base && head ? `branch-diff:${source.ref}:${base}:${head}` : null;
  }

  if (source.type === 'branch-working-tree') {
    if (
      typeof source.baseRef === 'string' &&
      typeof source.headRef === 'string' &&
      source.baseRef &&
      source.headRef
    ) {
      const base = await resolveCommitRef(host, repositoryRoot, source.baseRef);
      const head = await resolveCommitRef(host, repositoryRoot, source.headRef);
      return base && head ? `branch-working-tree:${source.ref}:${base}:${head}` : null;
    }

    const head = await resolveCommitRef(host, repositoryRoot, 'HEAD');
    const target = await resolveCommitRef(host, repositoryRoot, source.ref);
    const nextBase =
      target && head ? await resolveMergeBase(host, repositoryRoot, target, head) : null;
    return nextBase && head ? `branch-working-tree:${source.ref}:${nextBase}:${head}` : null;
  }

  if (source.type === 'pull-request') {
    return getPullRequestSourceKey(source);
  }

  return null;
};

/** @param {ReviewSource} source */
const getResolvedSourceKey = (source) => {
  if (source.type === 'working-tree') {
    return 'working-tree';
  }
  if (source.type === 'commit') {
    return source.github
      ? `commit:github:${source.github.owner.toLowerCase()}/${source.github.repo.toLowerCase()}:${source.ref.toLowerCase()}`
      : `commit:${source.ref.toLowerCase()}`;
  }
  if (source.type === 'branch-diff') {
    return `branch-diff:${source.ref}:${source.baseRef.toLowerCase()}:${source.headRef.toLowerCase()}`;
  }
  if (source.type === 'branch-working-tree' && source.baseRef && source.headRef) {
    return `branch-working-tree:${source.ref}:${source.baseRef.toLowerCase()}:${source.headRef.toLowerCase()}`;
  }
  if (source.type === 'pull-request') {
    return getPullRequestSourceKey(source);
  }
  return null;
};

/**
 * @param {RepositoryHost} host
 * @param {string} repositoryPath
 * @param {Partial<CodiffLaunchOptions>} [launchOptions]
 * @returns {Promise<WindowIdentity | null>}
 */
const getWindowIdentity = async (host, repositoryPath, launchOptions = {}) => {
  if (launchOptions.planFile) {
    // Plan files always live on this machine, whichever host the repository is on.
    const planPath = getRealPath(launchOptions.planFile);
    const resultPath = launchOptions.planResultFile
      ? getRealPath(launchOptions.planResultFile)
      : 'standalone';
    return {
      key: `plan:${planPath}\0${resultPath}`,
      repositoryRoot: getRealPath(dirname(planPath)),
      sourceKey: `plan:${planPath}`,
    };
  }
  const repositoryRoot = await resolveRepositoryRoot(host, repositoryPath);
  const implicitWalkthroughHead =
    launchOptions.walkthrough &&
    !launchOptions.walkthroughFile &&
    !launchOptions.source &&
    !(await hasWorkingTreeChanges(host, repositoryRoot))
      ? await resolveCommitRef(host, repositoryRoot, 'HEAD')
      : null;
  const sourceKey = implicitWalkthroughHead
    ? `commit:${implicitWalkthroughHead}`
    : await getSourceKey(host, repositoryRoot, launchOptions.source);
  return sourceKey
    ? {
        key: `${getRepositoryKey(host.id, repositoryRoot)}\0${sourceKey}`,
        repositoryRoot,
        sourceKey,
      }
    : null;
};

/** @param {RepositoryHost} host @param {string} repositoryPath @param {ReviewSource} source */
const getWindowIdentityForSource = (host, repositoryPath, source) =>
  getWindowIdentity(host, repositoryPath, { source });

/**
 * @param {RepositoryHost} host
 * @param {{root: string; source: ReviewSource}} state
 * @returns {Promise<WindowIdentity | null>}
 */
const getWindowIdentityForRepositoryState = async (host, state) => {
  const repositoryRoot = await getHostRealPath(host, state.root);
  const sourceKey = getResolvedSourceKey(state.source);
  return sourceKey
    ? {
        key: `${getRepositoryKey(host.id, repositoryRoot)}\0${sourceKey}`,
        repositoryRoot,
        sourceKey,
      }
    : null;
};

/**
 * @param {WindowIdentity | null} identity
 * @param {ReadonlyMap<number, WindowIdentity | null>} existingIdentities
 */
const findMatchingWindowIdentity = (identity, existingIdentities) => {
  if (!identity) {
    return null;
  }

  for (const [id, existingIdentity] of existingIdentities) {
    if (existingIdentity?.key === identity.key) {
      return id;
    }
  }

  return null;
};

module.exports = {
  findMatchingWindowIdentity,
  getWindowIdentity,
  getWindowIdentityForRepositoryState,
  getWindowIdentityForSource,
};
