// @ts-check

const {
  createSection,
  createSummary,
  fileSort,
  getFingerprint,
  getGravatarHash,
  getWhitespaceDiffArgs,
  git,
  normalizeStatus,
  prefetchWorkingTreeFiles,
  readGitFile,
  readGitImageFile,
  readWorkingTreeFile,
  readWorkingTreeImageFile,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');
const {
  readComparisonImageContent,
  readComparisonSectionContent,
  readComparisonState,
} = require('./comparison.cjs');
const { readCommitMetadataForCommit } = require('./commit-metadata.cjs');
const {
  applyGeneratedAttributeStates,
  readGeneratedAttributeStates,
} = require('../generated-files.cjs');
const { createEmptyFileContent } = require('./git-files.cjs');
const {
  listUntrackedItems,
  readDiffSectionContent: readWorkingTreeDiffSectionContent,
  shouldEagerlyReadWorkingTreeContents,
  splitPatchByPath,
} = require('./working-tree.cjs');

/**
 * @typedef {import('../host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffImageContentRequest} DiffImageContentRequest
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {Extract<ReviewSource, {type: 'branch'}>} BranchSource
 * @typedef {Extract<ReviewSource, {type: 'branch-diff'}>} BranchDiffSource
 * @typedef {Extract<ReviewSource, {type: 'branch-working-tree'}>} BranchWorkingTreeSource
 * @typedef {Extract<ReviewSource, {type: 'commit'}>} CommitSource
 * @typedef {Extract<ReviewSource, {type: 'range'}>} RangeSource
 * @typedef {BranchSource | BranchDiffSource | CommitSource | RangeSource} ComparisonSource
 * @typedef {CommitSource | BranchDiffSource | RangeSource} ResolvedComparisonSource
 * @typedef {{
 *   newRef: string;
 *   oldRef?: string;
 *   repoRoot: string;
 *   source: ResolvedComparisonSource;
 *   sourceLabel: string;
 *   status: Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>;
 * }} ResolvedComparison
 */

/**
 * @param {string} raw
 * @param {{sort?: boolean}} [options]
 * @returns {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>}
 */
const parseCommitNameStatus = (raw, options = {}) => {
  const parts = raw.split('\0').filter(Boolean);
  /** @type {Array<Pick<StatusItem, 'oldPath' | 'path' | 'status'>>} */
  const files = [];

  for (let index = 0; index < parts.length;) {
    const statusCode = parts[index++];
    const statusType = statusCode[0];

    if (statusType === 'R' || statusType === 'C') {
      const oldPath = parts[index++];
      const path = parts[index++];
      files.push({
        oldPath,
        path,
        status: 'renamed',
      });
    } else {
      const path = parts[index++];
      files.push({
        path,
        status: normalizeStatus(statusType),
      });
    }
  }

  return options.sort === false ? files : files.sort(fileSort);
};

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} commit @returns {Promise<Array<string>>} */
const readCommitParents = async (host, repoRoot, commit) => {
  const raw = (await git(host, repoRoot, ['rev-list', '--parents', '-n', '1', commit])).trim();
  return raw ? raw.split(' ').slice(1) : [];
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string | undefined} firstParent
 * @param {{sort?: boolean}} [options]
 */
const readCommitNameStatus = async (host, repoRoot, commit, firstParent, options = {}) =>
  parseCommitNameStatus(
    await git(
      host,
      repoRoot,
      firstParent
        ? ['diff', '--name-status', '-r', '-z', '-M', firstParent, commit]
        : ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', '--root', '-M', commit],
    ),
    options,
  );

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} ref
 */
const resolveRangeEndpoint = async (host, repoRoot, ref) => {
  if (ref !== 'HEAD') {
    try {
      return (
        await git(host, repoRoot, ['rev-parse', '--verify', `refs/heads/${ref}^{commit}`])
      ).trim();
    } catch {
      // Fall back to Git's normal ref parser for tags, hashes, and fully-qualified refs.
    }
  }

  return (await git(host, repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
};

/**
 * Resolve a `base...head` (symmetric -> merge-base) or `base..head` range to the
 * concrete (oldRef, newRef) pair the commit helpers diff against.
 * @param {RepositoryHost} host
 * @param {string} repoRoot @param {string} base @param {string} head @param {boolean} symmetric
 * @returns {Promise<{ newRef: string; oldRef: string }>}
 */
const resolveRangeRefs = async (host, repoRoot, base, head, symmetric) => {
  const newRef = await resolveRangeEndpoint(host, repoRoot, head);
  const oldRef = symmetric
    ? (
        await git(host, repoRoot, [
          'merge-base',
          await resolveRangeEndpoint(host, repoRoot, base),
          newRef,
        ])
      ).trim()
    : await resolveRangeEndpoint(host, repoRoot, base);
  return { newRef, oldRef };
};

/** @param {string} left @param {string} right */
const getEditDistance = (left, right) => {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current[rightIndex + 1] =
        left[leftIndex] === right[rightIndex]
          ? previous[rightIndex]
          : Math.min(previous[rightIndex], previous[rightIndex + 1], current[rightIndex]) + 1;
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
};

/** @param {string} requested @param {string} candidate */
const getBranchSuggestionScore = (requested, candidate) => {
  const requestedLower = requested.toLowerCase();
  const aliases = [candidate.toLowerCase()];
  const slashIndex = candidate.indexOf('/');
  if (slashIndex !== -1) {
    aliases.push(candidate.slice(slashIndex + 1).toLowerCase());
  }

  return Math.min(
    ...aliases.map((alias) => {
      if (
        (requestedLower === 'main' && alias === 'master') ||
        (requestedLower === 'master' && alias === 'main')
      ) {
        return 1;
      }

      return alias.startsWith(requestedLower) && requestedLower.length >= 3
        ? 1
        : getEditDistance(requestedLower, alias);
    }),
  );
};

/** @param {string} ref */
const getBranchSuggestionThreshold = (ref) =>
  ref.length <= 4 ? 1 : ref.length <= 8 ? 2 : Math.floor(ref.length / 3);

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} ref @returns {Promise<string | null>} */
const getBranchSuggestion = async (host, repoRoot, ref) => {
  const raw = await git(host, repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ]);
  const candidates = [
    ...new Set(
      raw
        .split('\n')
        .map((branch) => branch.trim())
        .filter((branch) => branch && !branch.endsWith('/HEAD') && branch !== ref),
    ),
  ];
  const [best] = candidates
    .map((branch) => ({
      branch,
      score: getBranchSuggestionScore(ref, branch),
    }))
    .sort((left, right) => left.score - right.score || left.branch.localeCompare(right.branch));

  return best && best.score <= getBranchSuggestionThreshold(ref) ? best.branch : null;
};

/** @param {string | BranchSource | BranchDiffSource} input @returns {BranchSource | BranchDiffSource} */
const normalizeBranchSourceInput = (input) =>
  typeof input === 'string' ? { ref: input, type: 'branch' } : input;

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {BranchSource | BranchDiffSource} source
 * @returns {Promise<{newRef: string; oldRef: string; source: BranchDiffSource; sourceLabel: string}>}
 */
const resolveBranchComparison = async (host, repoRoot, source) => {
  if (source.type === 'branch-diff') {
    return {
      newRef: source.headRef,
      oldRef: source.baseRef,
      source,
      sourceLabel: 'branch',
    };
  }

  const newRef = await resolveRangeEndpoint(host, repoRoot, 'HEAD');
  let branchRef;
  try {
    branchRef = await resolveRangeEndpoint(host, repoRoot, source.ref);
  } catch {
    const suggestion = await getBranchSuggestion(host, repoRoot, source.ref);
    throw new Error(
      `Branch "${source.ref}" does not exist in this repository.${
        suggestion ? ` Did you mean "${suggestion}"?` : ''
      }`,
    );
  }
  const oldRef = (await git(host, repoRoot, ['merge-base', branchRef, newRef])).trim();
  return {
    newRef,
    oldRef,
    source: {
      baseRef: oldRef,
      headRef: newRef,
      ref: source.ref,
      type: 'branch-diff',
    },
    sourceLabel: 'branch',
  };
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {ComparisonSource} source
 * @returns {Promise<Omit<ResolvedComparison, 'repoRoot' | 'status'>>}
 */
const resolveComparisonSource = async (host, repoRoot, source) => {
  if (source.type === 'commit') {
    const commit = (
      await git(host, repoRoot, ['rev-parse', '--verify', `${source.ref}^{commit}`])
    ).trim();
    const [firstParent] = await readCommitParents(host, repoRoot, commit);
    return {
      newRef: commit,
      oldRef: firstParent,
      source: {
        ref: commit,
        type: 'commit',
      },
      sourceLabel: 'commit',
    };
  }

  if (source.type === 'range') {
    const { newRef, oldRef } = await resolveRangeRefs(
      host,
      repoRoot,
      source.base,
      source.head,
      source.symmetric,
    );
    return {
      newRef,
      oldRef,
      source,
      sourceLabel: 'range',
    };
  }

  if (source.type === 'branch' || source.type === 'branch-diff') {
    return resolveBranchComparison(host, repoRoot, source);
  }

  throw new Error('Unsupported comparison source.');
};

/** @param {RepositoryHost} host @param {string} launchPath @param {ComparisonSource} source @returns {Promise<ResolvedComparison>} */
const readResolvedComparison = async (host, launchPath, source) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const comparison = await resolveComparisonSource(host, repoRoot, source);
  const status = await readCommitNameStatus(host, repoRoot, comparison.newRef, comparison.oldRef, {
    sort: false,
  });

  return {
    ...comparison,
    repoRoot,
    status,
  };
};

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} commit @returns {Promise<ResolvedComparison>} */
const readResolvedCommitComparison = async (host, repoRoot, commit) => {
  const [firstParent] = await readCommitParents(host, repoRoot, commit);
  const status = await readCommitNameStatus(host, repoRoot, commit, firstParent, {
    sort: false,
  });
  return {
    newRef: commit,
    oldRef: firstParent,
    repoRoot,
    source: {
      ref: commit,
      type: 'commit',
    },
    sourceLabel: 'commit',
    status,
  };
};

/** @param {RepositoryHost} host @param {string} launchPath @param {ResolvedComparison} comparison */
const readResolvedComparisonState = (host, launchPath, comparison) =>
  readComparisonState(host, {
    launchPath,
    newRef: comparison.newRef,
    oldRef: comparison.oldRef,
    repoRoot: comparison.repoRoot,
    source: comparison.source,
    status: comparison.status,
  });

/** @param {RepositoryHost} host @param {ResolvedComparison} comparison */
const readComparisonGeneratedAttributeStates = (host, comparison) =>
  readGeneratedAttributeStates(
    host,
    comparison.repoRoot,
    comparison.status.map((file) => file.path),
    comparison.newRef,
  );

/** @param {RepositoryHost} host @param {string} launchPath @param {ComparisonSource} source @returns {Promise<RepositoryState>} */
const readComparisonSourceState = async (host, launchPath, source) => {
  const comparison = await readResolvedComparison(host, launchPath, source);
  const [state, generatedAttributeStates] = await Promise.all([
    readResolvedComparisonState(host, launchPath, comparison),
    readComparisonGeneratedAttributeStates(host, comparison),
  ]);
  return applyGeneratedAttributeStates(state, generatedAttributeStates);
};

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {ComparisonSource} source
 * @param {string} requestedPath
 * @param {{force?: boolean}} [options]
 */
const readComparisonSourceSectionContent = async (
  host,
  launchPath,
  source,
  requestedPath,
  options = {},
) => {
  const comparison = await readResolvedComparison(host, launchPath, source);
  return readComparisonSectionContent(
    host,
    comparison.repoRoot,
    comparison.newRef,
    comparison.oldRef,
    comparison.status,
    requestedPath,
    comparison.sourceLabel,
    options,
  );
};

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {ComparisonSource} source
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readComparisonSourceImageContent = async (host, launchPath, source, requestedPath) => {
  try {
    const comparison = await readResolvedComparison(host, launchPath, source);
    return await readComparisonImageContent(
      host,
      comparison.repoRoot,
      comparison.newRef,
      comparison.oldRef,
      comparison.status,
      requestedPath,
      comparison.sourceLabel,
    );
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

/** @param {RepositoryHost} host @param {string} launchPath @param {ResolvedComparison} comparison */
const readCommitStateFromComparison = async (host, launchPath, comparison) => {
  const [commitMetadata, state, generatedAttributeStates] = await Promise.all([
    readCommitMetadataForCommit(
      host,
      comparison.repoRoot,
      comparison.newRef,
      comparison.oldRef,
      comparison.status,
    ),
    readResolvedComparisonState(host, launchPath, comparison),
    readComparisonGeneratedAttributeStates(host, comparison),
  ]);

  return {
    ...applyGeneratedAttributeStates(state, generatedAttributeStates),
    commitMetadata,
  };
};

/** @param {RepositoryHost} host @param {string} launchPath @param {string} ref @returns {Promise<RepositoryState>} */
const readCommitState = async (host, launchPath, ref) =>
  readCommitStateFromComparison(
    host,
    launchPath,
    await readResolvedComparison(host, launchPath, { ref, type: 'commit' }),
  );

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {string} repoRoot
 * @param {string} commit
 * @returns {Promise<RepositoryState>}
 */
const readResolvedCommitState = async (host, launchPath, repoRoot, commit) =>
  readCommitStateFromComparison(
    host,
    launchPath,
    await readResolvedCommitComparison(host, repoRoot, commit),
  );

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {string} ref
 * @param {string} requestedPath
 * @param {{force?: boolean}} [options]
 */
const readCommitSectionContent = (host, launchPath, ref, requestedPath, options = {}) =>
  readComparisonSourceSectionContent(
    host,
    launchPath,
    { ref, type: 'commit' },
    requestedPath,
    options,
  );

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {string} ref
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readCommitImageContent = (host, launchPath, ref, requestedPath) =>
  readComparisonSourceImageContent(host, launchPath, { ref, type: 'commit' }, requestedPath);

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath @param {string} base @param {string} head @param {boolean} symmetric
 * @returns {Promise<RepositoryState>}
 */
const readRangeState = (host, launchPath, base, head, symmetric) =>
  readComparisonSourceState(host, launchPath, {
    base,
    head,
    symmetric,
    type: 'range',
  });

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath @param {string} base @param {string} head @param {boolean} symmetric @param {string} requestedPath @param {{encoding?: BufferEncoding, force?: boolean}} [options]
 */
const readRangeSectionContent = (
  host,
  launchPath,
  base,
  head,
  symmetric,
  requestedPath,
  options = {},
) =>
  readComparisonSourceSectionContent(
    host,
    launchPath,
    {
      base,
      head,
      symmetric,
      type: 'range',
    },
    requestedPath,
    options,
  );

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath @param {string} base @param {string} head @param {boolean} symmetric @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readRangeImageContent = (host, launchPath, base, head, symmetric, requestedPath) =>
  readComparisonSourceImageContent(
    host,
    launchPath,
    {
      base,
      head,
      symmetric,
      type: 'range',
    },
    requestedPath,
  );

/** @param {RepositoryHost} host @param {string} launchPath @param {string | BranchSource | BranchDiffSource} input @returns {Promise<RepositoryState>} */
const readBranchState = (host, launchPath, input) =>
  readComparisonSourceState(host, launchPath, normalizeBranchSourceInput(input));

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {string | BranchSource | BranchDiffSource} input
 * @param {string} requestedPath
 * @param {{force?: boolean}} [options]
 */
const readBranchSectionContent = (host, launchPath, input, requestedPath, options = {}) =>
  readComparisonSourceSectionContent(
    host,
    launchPath,
    normalizeBranchSourceInput(input),
    requestedPath,
    options,
  );

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {string | BranchSource | BranchDiffSource} input
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readBranchImageContent = (host, launchPath, input, requestedPath) =>
  readComparisonSourceImageContent(
    host,
    launchPath,
    normalizeBranchSourceInput(input),
    requestedPath,
  );

/**
 * Reduce a `branch-working-tree` input (which may or may not already carry a
 * resolved baseRef/headRef) down to the plain branch/branch-diff shape that
 * {@link resolveBranchComparison} already understands.
 * @param {BranchWorkingTreeSource} input
 * @returns {BranchSource | BranchDiffSource}
 */
const toBranchComparisonInput = (input) =>
  input.baseRef && input.headRef
    ? { baseRef: input.baseRef, headRef: input.headRef, ref: input.ref, type: 'branch-diff' }
    : { ref: input.ref, type: 'branch' };

/**
 * Like `git diff <ref>`, a `branch-working-tree` source compares one base
 * commit directly with the working tree. The base is the merge-base of `ref`
 * and `HEAD`, so a diverged branch does not show its own new commits reversed.
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {BranchWorkingTreeSource} input
 * @returns {Promise<{baseRef: string; repoRoot: string; source: BranchWorkingTreeSource}>}
 */
const resolveBranchWorkingTree = async (host, launchPath, input) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const { source } = await resolveBranchComparison(host, repoRoot, toBranchComparisonInput(input));
  return {
    baseRef: source.baseRef,
    repoRoot,
    source: {
      baseRef: source.baseRef,
      headRef: source.headRef,
      ref: input.ref,
      type: 'branch-working-tree',
    },
  };
};

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} baseRef */
const readBranchWorkingTreeTrackedStatus = async (host, repoRoot, baseRef) =>
  parseCommitNameStatus(
    await git(host, repoRoot, ['diff', '--name-status', '-r', '-z', '-M', baseRef, '--']),
  );

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} baseRef
 * @param {Pick<StatusItem, 'oldPath' | 'path'>} item
 * @param {{showWhitespace?: boolean}} [options]
 */
const readBranchWorkingTreePatch = async (host, repoRoot, baseRef, item, options = {}) => {
  const patch = await git(host, repoRoot, [
    'diff',
    '--patch',
    '--no-ext-diff',
    '-M',
    ...getWhitespaceDiffArgs(options),
    baseRef,
    '--',
    ...(item.oldPath ? [item.oldPath] : []),
    item.path,
  ]);
  return { binary: /Binary files .* differ/.test(patch), patch };
};

/**
 * A single section from `baseRef` to the file on disk. It uses the `unstaged`
 * kind because its new side is the working-tree file, which is what editing
 * and definition search key off.
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} baseRef
 * @param {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} item
 * @param {{force?: boolean; patch?: {binary: boolean; patch: string}; patchOnly?: boolean; showWhitespace?: boolean}} [options]
 * @returns {Promise<DiffSection>}
 */
const createBranchWorkingTreeSection = async (host, repoRoot, baseRef, item, options = {}) => {
  const id = `${item.path}:unstaged`;
  /** @type {DiffSection['kind']} */
  const kind = 'unstaged';

  if (options.patchOnly) {
    const patch =
      options.patch ?? (await readBranchWorkingTreePatch(host, repoRoot, baseRef, item, options));
    return patch.binary
      ? {
          binary: true,
          id,
          kind,
          loadState: 'binary',
          patch: '',
          summary: createSummary('Binary file changed.', { canLoad: false }),
        }
      : { binary: false, id, kind, loadState: 'ready', patch: patch.patch };
  }

  const [oldFile, newFile] = await Promise.all([
    item.status === 'added'
      ? createEmptyFileContent(item.path)
      : readGitFile(host, repoRoot, baseRef, item.oldPath || item.path, options),
    item.status === 'deleted'
      ? createEmptyFileContent(item.path)
      : readWorkingTreeFile(host, repoRoot, item.path, options),
  ]);
  const summary = summarizeContent(oldFile, newFile);
  if (summary.loadState !== 'ready') {
    return {
      binary: summary.binary,
      id,
      kind,
      loadState: summary.loadState,
      patch: '',
      summary: summary.summary,
    };
  }

  const patch = await readBranchWorkingTreePatch(host, repoRoot, baseRef, item, options);
  return {
    binary: patch.binary,
    id,
    kind,
    loadState: 'ready',
    newFile: newFile.file,
    oldFile: oldFile.file,
    patch: patch.patch,
  };
};

/**
 * @param {string} baseRef
 * @param {Pick<StatusItem, 'oldPath' | 'path' | 'status'>} item
 * @param {DiffSection} section
 * @returns {ChangedFile}
 */
const createBranchWorkingTreeFile = (baseRef, item, section) => ({
  fingerprint: getFingerprint(
    `${baseRef}\n${item.status}\n${item.oldPath || ''}\n${section.loadState || 'ready'}\n${
      section.binary ? 'binary' : 'text'
    }\n${section.patch}\n${section.summary?.reason || ''}\n${section.summary?.fingerprint || ''}\n${
      section.oldFile?.contents || ''
    }\n${section.newFile?.contents || ''}`,
  ),
  oldPath: item.oldPath,
  path: item.path,
  sections: [section],
  status: item.status,
});

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {BranchWorkingTreeSource} input
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readBranchWorkingTreeState = async (host, launchPath, input, options = {}) => {
  const { baseRef, repoRoot, source } = await resolveBranchWorkingTree(host, launchPath, input);
  const [tracked, untrackedItems, rawPatch] = await Promise.all([
    readBranchWorkingTreeTrackedStatus(host, repoRoot, baseRef),
    listUntrackedItems(host, repoRoot),
    git(host, repoRoot, [
      'diff',
      '--patch',
      '--no-ext-diff',
      '-M',
      ...getWhitespaceDiffArgs(options),
      baseRef,
      '--',
    ]),
  ]);
  const trackedPaths = new Set(tracked.map((item) => item.path));
  const untracked = untrackedItems.filter((item) => !trackedPaths.has(item.path));
  const patches = splitPatchByPath(rawPatch);
  const prefetchedFiles = await prefetchWorkingTreeFiles(
    host,
    repoRoot,
    untracked.filter((item) => !item.directory && !item.summary).map((item) => item.path),
  );
  /** @type {Array<ChangedFile>} */
  const files = [];

  for (const item of tracked) {
    files.push(
      createBranchWorkingTreeFile(
        baseRef,
        item,
        await createBranchWorkingTreeSection(host, repoRoot, baseRef, item, {
          patch: patches.get(item.path),
          patchOnly: !shouldEagerlyReadWorkingTreeContents(item.path),
          showWhitespace: options.showWhitespace,
        }),
      ),
    );
  }

  for (const item of untracked) {
    files.push(
      createBranchWorkingTreeFile(
        baseRef,
        item,
        await createSection(host, repoRoot, item, 'unstaged', {
          prefetched: prefetchedFiles.get(item.path),
          showWhitespace: options.showWhitespace,
        }),
      ),
    );
  }

  return {
    files: files.sort(fileSort),
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source,
  };
};

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {DiffSectionContentRequest} request
 */
const readBranchWorkingTreeSectionContent = async (host, launchPath, request) => {
  const { baseRef, repoRoot } = await resolveBranchWorkingTree(
    host,
    launchPath,
    /** @type {BranchWorkingTreeSource} */ (request.source),
  );
  const path = validateRepositoryPath(request.path);
  const item = (await readBranchWorkingTreeTrackedStatus(host, repoRoot, baseRef)).find(
    (candidate) => candidate.path === path,
  );
  // Untracked files are not part of `git diff <base>`; load them like local changes.
  return item
    ? createBranchWorkingTreeSection(host, repoRoot, baseRef, item, {
        force: request.force,
        showWhitespace: request.showWhitespace,
      })
    : readWorkingTreeDiffSectionContent(host, launchPath, { ...request, kind: 'unstaged' });
};

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {DiffImageContentRequest} request
 * @returns {Promise<DiffImageContentResult>}
 */
const readBranchWorkingTreeImageContent = async (host, launchPath, request) => {
  try {
    const { baseRef, repoRoot } = await resolveBranchWorkingTree(
      host,
      launchPath,
      /** @type {BranchWorkingTreeSource} */ (request.source),
    );
    const path = validateRepositoryPath(request.path);
    const item = (await readBranchWorkingTreeTrackedStatus(host, repoRoot, baseRef)).find(
      (candidate) => candidate.path === path,
    );
    const [oldImage, newImage] = await Promise.all([
      item && item.status !== 'added'
        ? readGitImageFile(host, repoRoot, baseRef, item.oldPath || item.path)
        : undefined,
      item?.status === 'deleted' ? undefined : readWorkingTreeImageFile(host, repoRoot, path),
    ]);

    if (!oldImage && !newImage) {
      return {
        reason: 'Codiff could not load either side of this image.',
        status: 'unavailable',
      };
    }

    return {
      ...(newImage ? { newImage } : {}),
      ...(oldImage ? { oldImage } : {}),
      status: 'ready',
    };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

/** @param {RepositoryHost} host @param {string} launchPath @param {number} [limit] @param {string} [ref] */
const listRepositoryHistory = async (host, launchPath, limit = 200, ref = 'HEAD') => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  try {
    if (ref.includes('..')) {
      await git(host, repoRoot, ['rev-list', '--max-count=1', ref]);
    } else {
      await git(host, repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
    }
  } catch {
    return {
      entries: [],
      root: repoRoot,
    };
  }

  const raw = await git(host, repoRoot, [
    'log',
    `--max-count=${limit}`,
    '--format=%H%x1f%P%x1f%ct%x1f%s%x1f%aN%x1f%aE%x1e',
    ref,
  ]);
  const entries = [];

  for (const record of raw.split('\x1e')) {
    const [ref, parents, committedAt, subject, author, email] = record.trim().split('\x1f');
    if (!ref || !committedAt || subject == null) {
      continue;
    }

    const gravatarUrl = email
      ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
      : undefined;

    entries.push({
      author: author || '',
      committedAt: Number(committedAt) * 1000,
      gravatarUrl,
      parents: parents ? parents.split(' ') : [],
      ref,
      subject,
    });
  }

  return {
    entries,
    root: repoRoot,
  };
};

module.exports = {
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
};
