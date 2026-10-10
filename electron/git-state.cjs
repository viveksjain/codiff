// @ts-check

const { git, gitOrEmpty, parseStatus, validateRepositoryPath } = require('./git-state/common.cjs');
const {
  listRepositoryHistory,
  readBranchImageContent,
  readBranchSectionContent,
  readBranchState,
  readBranchWorkingTreeImageContent,
  readBranchWorkingTreeSectionContent,
  readBranchWorkingTreeState,
  readCommitImageContent,
  readCommitSectionContent,
  readCommitState,
  readResolvedCommitState,
  readRangeImageContent,
  readRangeSectionContent,
  readRangeState,
} = require('./git-state/commit.cjs');
const { parseRepositoryWatcherStatus } = require('./repository-watcher.cjs');
const {
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createPullRequestSection,
  createPullRequestSource,
  getPullRequestHeadImageSource,
  listPullRequestHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  parseGitHubPullRequestUrl,
  readPullRequestImageContent,
  readPullRequestState,
  resolvePullRequestContentRefs,
  selectUnresolvedReviewComments,
  submitPullRequestComment,
  submitPullRequestReview,
} = require('./git-state/pull-request.cjs');
const {
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  listMergeRequestHistory,
  normalizeGitLabReviewComment,
  parseGitLabMergeRequestUrl,
  readMergeRequestImageContent,
  readMergeRequestState,
  submitMergeRequestComment,
  submitMergeRequestReview,
} = require('./git-state/merge-request.cjs');
const { parseReviewUrl } = require('./review-source.cjs');
const {
  readDiffSectionContent: readWorkingTreeDiffSectionContent,
  readDiffImageContent: readWorkingTreeDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
} = require('./git-state/working-tree.cjs');
const { annotateGeneratedFiles } = require('./generated-files.cjs');

/**
 * @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../core/types.ts').DiffImageContentRequest} DiffImageContentRequest
 * @typedef {import('../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../core/types.ts').RepositoryHistory} RepositoryHistory
 * @typedef {import('../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../core/types.ts').ReviewSource} ReviewSource
 */

/** @param {RepositoryHost} host @param {string} launchPath @param {ReviewSource} [source] @param {{showWhitespace?: boolean}} [options] @returns {Promise<RepositoryState>} */
const readRepositoryState = async (
  host,
  launchPath,
  source = { type: 'working-tree' },
  options = {},
) => {
  const state =
    source.type === 'pull-request'
      ? await (isGitLabReviewSource(source) ? readMergeRequestState : readPullRequestState)(
          host,
          launchPath,
          source,
        )
      : source.type === 'commit'
        ? await readCommitState(host, launchPath, source.ref)
        : source.type === 'range'
          ? await readRangeState(host, launchPath, source.base, source.head, source.symmetric)
          : source.type === 'branch' || source.type === 'branch-diff'
            ? await readBranchState(host, launchPath, source)
            : source.type === 'branch-working-tree'
              ? await readBranchWorkingTreeState(host, launchPath, source, {
                  showWhitespace: options.showWhitespace,
                })
              : await readWorkingTreeState(host, launchPath, {
                  eagerContents: false,
                  showWhitespace: options.showWhitespace,
                });
  const comparisonState =
    source.type === 'commit' ||
    source.type === 'range' ||
    source.type === 'branch' ||
    source.type === 'branch-diff';
  const [branch, annotatedState] = await Promise.all([
    gitOrEmpty(host, state.root, ['symbolic-ref', '--short', 'HEAD']),
    comparisonState ? state : annotateGeneratedFiles(host, state),
  ]);
  return { ...annotatedState, branch: branch.trim() || null };
};

/**
 * An implicit walkthrough reviews local changes when present and otherwise
 * reviews the current commit. Explicit sources always retain their semantics.
 *
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {ReviewSource} [source]
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readWalkthroughRepositoryState = async (host, launchPath, source, options = {}) => {
  if (source) {
    return readRepositoryState(host, launchPath, source, options);
  }

  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const status = parseRepositoryWatcherStatus(
    await git(host, repoRoot, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--no-ahead-behind',
      '-z',
      '-uall',
    ]),
  );
  if (status.paths.length > 0) {
    return readRepositoryState(host, launchPath, undefined, options);
  }

  const [head, branchHead] = status.head.split('\0');
  const branch = branchHead && branchHead !== '(detached)' ? branchHead : null;
  if (/^[0-9a-f]+$/i.test(head)) {
    const state = await readResolvedCommitState(host, launchPath, repoRoot, head);
    return { ...state, branch };
  }

  return {
    branch,
    files: [],
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: {
      type: 'working-tree',
    },
  };
};

/** @param {Extract<ReviewSource, {type: 'pull-request'}>} source */
const isGitLabReviewSource = (source) =>
  source.provider === 'gitlab' || parseReviewUrl(source.url)?.provider === 'gitlab';

/** @param {Extract<ReviewSource, {type: 'branch' | 'branch-diff' | 'branch-working-tree'}>} source */
const getBranchHistoryRef = (source) =>
  source.type !== 'branch' && source.baseRef && source.headRef
    ? `${source.baseRef}..${source.headRef}`
    : `${source.ref}..HEAD`;

/** @param {RepositoryHost} host @param {string} launchPath @param {number} [limit] @param {ReviewSource} [source] @returns {Promise<RepositoryHistory>} */
const readRepositoryHistory = (host, launchPath, limit, source) =>
  source?.type === 'pull-request'
    ? (isGitLabReviewSource(source) ? listMergeRequestHistory : listPullRequestHistory)(
        host,
        launchPath,
        source,
        limit,
      )
    : listRepositoryHistory(
        host,
        launchPath,
        limit,
        source?.type === 'branch' ||
          source?.type === 'branch-diff' ||
          source?.type === 'branch-working-tree'
          ? getBranchHistoryRef(source)
          : undefined,
      );

/** @param {RepositoryHost} host @param {string} launchPath @param {DiffSectionContentRequest} request */
const readDiffSectionContent = async (host, launchPath, request) =>
  request.source?.type === 'range'
    ? readRangeSectionContent(
        host,
        launchPath,
        request.source.base,
        request.source.head,
        request.source.symmetric,
        request.path,
        { force: request.force },
      )
    : request.source?.type === 'branch' || request.source?.type === 'branch-diff'
      ? readBranchSectionContent(host, launchPath, request.source, request.path, {
          force: request.force,
        })
      : request.source?.type === 'branch-working-tree'
        ? readBranchWorkingTreeSectionContent(host, launchPath, request)
        : request.kind === 'commit' || request.source?.type === 'commit'
          ? readCommitSectionContent(
              host,
              launchPath,
              request.source?.ref || 'HEAD',
              request.path,
              {
                force: request.force,
              },
            )
          : readWorkingTreeDiffSectionContent(host, launchPath, request);

/** @param {RepositoryHost} host @param {string} launchPath @param {DiffImageContentRequest} request @returns {Promise<DiffImageContentResult>} */
const readDiffImageContent = (host, launchPath, request) =>
  request.source?.type === 'pull-request'
    ? (isGitLabReviewSource(request.source)
        ? readMergeRequestImageContent
        : readPullRequestImageContent)(host, launchPath, request.source, request.path)
    : request.source?.type === 'range'
      ? readRangeImageContent(
          host,
          launchPath,
          request.source.base,
          request.source.head,
          request.source.symmetric,
          request.path,
        )
      : request.source?.type === 'branch' || request.source?.type === 'branch-diff'
        ? readBranchImageContent(host, launchPath, request.source, request.path)
        : request.source?.type === 'branch-working-tree'
          ? readBranchWorkingTreeImageContent(host, launchPath, request)
          : request.kind === 'commit' || request.source?.type === 'commit'
            ? readCommitImageContent(host, launchPath, request.source?.ref || 'HEAD', request.path)
            : readWorkingTreeDiffImageContent(host, launchPath, request);

module.exports = {
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPullRequestHistoryFetchRefspecs,
  createGitLabPosition,
  createMergeRequestFetchRefspecs,
  createPullRequestSection,
  createPullRequestSource,
  getPullRequestHeadImageSource,
  listRepositoryHistory: readRepositoryHistory,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizeGitLabReviewComment,
  normalizePullRequestComment,
  parseStatus,
  parseGitHubPullRequestUrl,
  parseGitLabMergeRequestUrl,
  selectUnresolvedReviewComments,
  readBranchState,
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readCommitState,
  readPullRequestState,
  readRepositoryState,
  readWalkthroughRepositoryState,
  readWorkingTreeState,
  resolvePullRequestContentRefs,
  /** @param {RepositoryHost} host */
  submitPullRequestComment: (host, launchPath, request) =>
    (isGitLabReviewSource(request.source) ? submitMergeRequestComment : submitPullRequestComment)(
      host,
      launchPath,
      request,
    ),
  /** @param {RepositoryHost} host */
  submitPullRequestReview: (host, launchPath, request) =>
    (isGitLabReviewSource(request.source) ? submitMergeRequestReview : submitPullRequestReview)(
      host,
      launchPath,
      request,
    ),
  validateRepositoryPath,
};
