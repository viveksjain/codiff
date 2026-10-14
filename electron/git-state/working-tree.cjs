// @ts-check

const { readRepositoryChangeSignature } = require('../repository-watcher.cjs');
const { quoteFish, quotePosix } = require('../host/shell-quote.cjs');
const {
  GENERATED_DIRECTORY_NAMES,
  createSection,
  createSummary,
  fileSort,
  generatedDirectoryPathspecExcludes,
  getFingerprint,
  getGravatarHash,
  getWhitespaceDiffArgs,
  git,
  MAX_UNTRACKED_INITIAL_ITEMS,
  parseStatus,
  prefetchWorkingTreeFiles,
  readFileStat,
  readGitImageFile,
  readIndexImageFile,
  readWorkingTreeImageFile,
  validateRepositoryPath,
} = require('./common.cjs');

/**
 * @typedef {import('../host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffImageContentRequest} DiffImageContentRequest
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('./common.cjs').StatusItem} StatusItem
 * @typedef {'staged' | 'unstaged'} WorkingTreeSectionKind
 */

const diffGitHeaderPattern = /^diff --git (.+)$/;

/** @param {string} value */
const unquoteGitPath = (value) => {
  if (!value.startsWith('"')) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value.slice(1, value.endsWith('"') ? -1 : undefined);
  }
};

/** @param {string} line */
const splitDiffGitHeader = (line) => {
  const match = line.match(diffGitHeaderPattern);
  if (!match) {
    return null;
  }

  const paths = [];
  let index = 0;
  const value = match[1];
  while (index < value.length && paths.length < 2) {
    while (value[index] === ' ') {
      index += 1;
    }

    if (value[index] === '"') {
      let end = index + 1;
      let escaped = false;
      while (end < value.length) {
        const char = value[end];
        if (char === '"' && !escaped) {
          end += 1;
          break;
        }
        escaped = char === '\\' && !escaped;
        if (char !== '\\') {
          escaped = false;
        }
        end += 1;
      }
      paths.push(unquoteGitPath(value.slice(index, end)));
      index = end;
      continue;
    }

    const end = value.indexOf(' ', index);
    if (end === -1) {
      paths.push(value.slice(index));
      break;
    }

    paths.push(value.slice(index, end));
    index = end + 1;
  }

  return paths.length === 2 ? paths : null;
};

/** @param {string} path */
const stripGitDiffPrefix = (path) =>
  path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;

/** @param {string} path */
const shouldEagerlyReadWorkingTreeContents = (path) => /\.md$/i.test(path);

/** @param {string} rawPatch @returns {Map<string, {binary: boolean; patch: string}>} */
const splitPatchByPath = (rawPatch) => {
  const patches = new Map();
  const starts = [];
  const pattern = /^diff --git .+$/gm;
  let match;

  while ((match = pattern.exec(rawPatch))) {
    starts.push(match.index);
  }

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? rawPatch.length;
    const patch = rawPatch.slice(start, end);
    const header = patch.slice(0, patch.indexOf('\n') === -1 ? patch.length : patch.indexOf('\n'));
    const paths = splitDiffGitHeader(header);
    const path = paths ? stripGitDiffPrefix(paths[1]) : null;
    if (path) {
      patches.set(path, {
        binary: /Binary files .* differ/.test(patch),
        patch,
      });
    }
  }

  return patches;
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {WorkingTreeSectionKind} kind
 * @param {{showWhitespace?: boolean}} [options]
 * @returns {Promise<Map<string, {binary: boolean; patch: string}>>}
 */
const readPatchMap = async (host, repoRoot, kind, options = {}) => {
  const whitespaceArgs = getWhitespaceDiffArgs(options);
  const args =
    kind === 'staged'
      ? ['diff', '--cached', '--patch', '--no-ext-diff', ...whitespaceArgs]
      : ['diff', '--patch', '--no-ext-diff', ...whitespaceArgs];
  return splitPatchByPath(await git(host, repoRoot, args));
};

/** @param {string} path */
const getGeneratedDirectoryPath = (path) => {
  const parts = path.split('/');
  // The last component is either a filename or empty for a directory entry.
  const index = parts.slice(0, -1).findIndex((part) => GENERATED_DIRECTORY_NAMES.has(part));
  return index === -1 ? null : parts.slice(0, index + 1).join('/');
};

/** @param {string} directory */
const getGeneratedDirectoryPathspecs = (directory) => {
  const globDirectory = directory.replace(/[\\*?[\]]/g, '\\$&');
  return [...GENERATED_DIRECTORY_NAMES].map((name) => `:(glob)${globDirectory}**/${name}/`);
};

/** @param {ReadonlyArray<string>} pathspecs */
const batchUntrackedPathspecs = (pathspecs) => {
  /** @type {Array<Array<string>>} */
  const batches = [];
  /** @type {Array<string>} */
  let batch = [];
  let bytes = 0;
  for (const pathspec of pathspecs) {
    // Budget arguments after both layers of SSH shell quoting. Leave room for
    // the command and fixed pathspecs below Linux's remote argument limit.
    const quoted = quotePosix(pathspec);
    const size =
      Math.max(Buffer.byteLength(quotePosix(quoted)), Buffer.byteLength(quoteFish(quoted))) + 1;
    if (batch.length > 0 && bytes + size > 32 * 1024) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(pathspec);
    bytes += size;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
};

/** @param {RepositoryHost} host @param {string} repoRoot @returns {Promise<Array<StatusItem>>} */
const listUntrackedItems = async (host, repoRoot) => {
  // Unlike ls-files, status can use Git's untracked cache. Avoid pathspecs
  // here so Git can collapse new directories, then expand only ordinary
  // new subtrees instead of walking the whole checkout twice.
  const raw = await git(host, repoRoot, [
    'status',
    '--porcelain=v1',
    '--no-ahead-behind',
    '--untracked-files=normal',
    '-z',
  ]);
  /** @type {Set<string>} */
  const files = new Set();
  /** @type {Set<string>} */
  const collapsedDirectories = new Set();
  /** @type {Array<string>} */
  const directories = [];
  for (const { path } of parseStatus(raw).filter((item) => item.untracked)) {
    const generatedDirectory = getGeneratedDirectoryPath(path);
    if (generatedDirectory) {
      collapsedDirectories.add(generatedDirectory);
    } else if (path.endsWith('/')) {
      directories.push(path);
    } else {
      files.add(path);
    }
  }

  // Keep the original repository context: -C into a new directory could
  // enter an embedded repository and return paths from its own index.
  // Split individual pathspecs, since one long directory produces many of them.
  const [fileOutputs, directoryOutputs] = await Promise.all([
    Promise.all(
      batchUntrackedPathspecs(directories.map((directory) => `:(literal)${directory}`)).map(
        (batch) =>
          git(host, repoRoot, [
            'ls-files',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            ...batch,
            ...generatedDirectoryPathspecExcludes,
          ]),
      ),
    ),
    Promise.all(
      batchUntrackedPathspecs(directories.flatMap(getGeneratedDirectoryPathspecs)).map((batch) =>
        git(host, repoRoot, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '--directory',
          '-z',
          '--',
          ...batch,
        ]),
      ),
    ),
  ]);
  for (const path of fileOutputs.join('').split('\0').filter(Boolean)) {
    if (path.endsWith('/')) {
      collapsedDirectories.add(path.slice(0, -1));
    } else {
      files.add(path);
    }
  }
  for (const path of directoryOutputs.join('').split('\0').filter(Boolean)) {
    const generatedDirectory = getGeneratedDirectoryPath(path);
    if (generatedDirectory) {
      collapsedDirectories.add(generatedDirectory);
    }
  }

  const paths = [...files].sort();
  /** @type {Array<StatusItem>} */
  const items = paths.slice(0, MAX_UNTRACKED_INITIAL_ITEMS).map((path) => ({
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  }));

  if (paths.length > MAX_UNTRACKED_INITIAL_ITEMS) {
    const omitted = paths.length - MAX_UNTRACKED_INITIAL_ITEMS;
    items.push({
      directory: true,
      path: `Untracked files not shown (${omitted} more)`,
      staged: false,
      status: 'untracked',
      summary: createSummary(`${omitted} untracked files are not shown.`, {
        canLoad: false,
        fileCount: omitted,
        loadState: 'directory',
      }),
      unstaged: true,
      untracked: true,
    });
  }

  for (const path of collapsedDirectories) {
    items.push({
      directory: true,
      path,
      staged: false,
      status: 'untracked',
      unstaged: true,
      untracked: true,
    });
  }

  const unique = new Map();
  for (const item of items) {
    unique.set(item.path, item);
  }

  return [...unique.values()].sort(fileSort);
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {Array<StatusItem>} status
 * @param {{eagerContents?: boolean; showWhitespace?: boolean}} options
 * @returns {Promise<Array<ChangedFile>>}
 */
const readWorkingTreeFiles = async (host, repoRoot, status, options) => {
  const prefetchedFiles = await prefetchWorkingTreeFiles(
    host,
    repoRoot,
    status
      .filter((item) => item.untracked && !item.directory && !item.summary)
      .map((item) => item.path),
  );
  const shouldUsePatchOnly = options.eagerContents === false;
  const hasTrackedFiles = status.some((item) => !item.untracked);
  const [stagedPatches, unstagedPatches] =
    shouldUsePatchOnly && hasTrackedFiles
      ? await Promise.all([
          readPatchMap(host, repoRoot, 'staged', options),
          readPatchMap(host, repoRoot, 'unstaged', options),
        ])
      : [new Map(), new Map()];
  /** @type {Array<ChangedFile>} */
  const files = [];

  for (const item of status) {
    /** @type {Array<DiffSection>} */
    const sections = [];
    const patchOnly = shouldUsePatchOnly && !shouldEagerlyReadWorkingTreeContents(item.path);

    if (item.staged) {
      sections.push(
        await createSection(host, repoRoot, item, 'staged', {
          patch: stagedPatches.get(item.path),
          patchOnly,
          showWhitespace: options.showWhitespace,
        }),
      );
    }

    if (item.unstaged) {
      sections.push(
        await createSection(host, repoRoot, item, 'unstaged', {
          patch: item.status === 'conflicted' ? undefined : unstagedPatches.get(item.path),
          patchOnly,
          prefetched: item.untracked ? prefetchedFiles.get(item.path) : undefined,
          showWhitespace: options.showWhitespace,
        }),
      );
    }

    const fingerprint = getFingerprint(
      `${item.status}\n${item.oldPath || ''}\n${sections
        .map(
          (section) =>
            `${section.loadState || 'ready'}\n${section.binary ? 'binary' : 'text'}\n${
              section.patch
            }\n${section.summary?.reason || ''}\n${section.summary?.fingerprint || ''}\n${
              section.oldFile?.contents || ''
            }\n${section.newFile?.contents || ''}`,
        )
        .join('\n')}`,
    );

    files.push({
      fingerprint,
      oldPath: item.oldPath,
      path: item.path,
      sections,
      status: item.status,
    });
  }

  return files;
};

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {{eagerContents?: boolean; showWhitespace?: boolean; onTrackedState?: (state: RepositoryState) => void | Promise<void>}} [options]
 * @returns {Promise<RepositoryState>}
 */
const readWorkingTreeState = async (host, launchPath, options = {}) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  /** @param {Array<ChangedFile>} files @returns {RepositoryState} */
  const createState = (files) => ({
    branch: null,
    files,
    generatedAt: Date.now(),
    launchPath,
    root: repoRoot,
    source: { type: 'working-tree' },
  });
  const [trackedFiles, untrackedFiles] = await Promise.all([
    (async () => {
      const status = parseStatus(
        await git(host, repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
      );
      const files = await readWorkingTreeFiles(host, repoRoot, status, options);
      await options.onTrackedState?.({ ...createState(files), untrackedLoading: true });
      return files;
    })(),
    (async () =>
      readWorkingTreeFiles(host, repoRoot, await listUntrackedItems(host, repoRoot), options))(),
  ]);
  return createState([...trackedFiles, ...untrackedFiles].sort(fileSort));
};

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} path @returns {Promise<StatusItem>} */
const getStatusItemForPath = async (host, repoRoot, path) => {
  const trackedStatus = parseStatus(
    await git(host, repoRoot, ['status', '--porcelain=v1', '-z', '-uno']),
  );
  const trackedItem = trackedStatus.find((item) => item.path === path);
  if (trackedItem) {
    return trackedItem;
  }

  const stat = await readFileStat(host, repoRoot, path);
  return {
    directory: stat?.type === 'directory',
    path,
    staged: false,
    status: 'untracked',
    unstaged: true,
    untracked: true,
  };
};

/** @param {RepositoryHost} host @param {string} launchPath @param {DiffSectionContentRequest} request */
const readDiffSectionContent = async (host, launchPath, request) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const path = validateRepositoryPath(request.path);
  if (request.kind === 'commit' || request.source?.type === 'commit') {
    throw new Error('Lazy loading commit diffs is not supported.');
  }

  const item = await getStatusItemForPath(host, repoRoot, path);
  return createSection(host, repoRoot, item, /** @type {WorkingTreeSectionKind} */ (request.kind), {
    force: request.force,
    showWhitespace: request.showWhitespace,
  });
};

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {DiffImageContentRequest} request
 * @returns {Promise<DiffImageContentResult>}
 */
const readDiffImageContent = async (host, launchPath, request) => {
  try {
    const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const path = validateRepositoryPath(request.path);
    if (request.kind === 'commit' || request.source?.type === 'commit') {
      throw new Error('Commit image diffs are loaded through the commit reader.');
    }

    const item = await getStatusItemForPath(host, repoRoot, path);
    const oldPath = item.oldPath || item.path;
    const [oldImage, newImage] =
      request.kind === 'staged'
        ? await Promise.all([
            readGitImageFile(host, repoRoot, 'HEAD', oldPath),
            readIndexImageFile(host, repoRoot, item.path),
          ])
        : await Promise.all([
            item.untracked
              ? undefined
              : readIndexImageFile(host, repoRoot, item.path, item.conflictStage),
            readWorkingTreeImageFile(host, repoRoot, item.path),
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

/** @param {RepositoryHost} host @param {string} repoRoot @param {ReadonlyArray<string>} args */
const gitOrEmpty = async (host, repoRoot, args) => {
  try {
    return await git(host, repoRoot, args);
  } catch {
    return '';
  }
};

/** @param {RepositoryHost} host @param {string} launchPath */
const readGitIdentity = async (host, launchPath) => {
  const [configuredName, configuredEmail] = await Promise.all([
    gitOrEmpty(host, launchPath, ['config', '--get', 'user.name']),
    gitOrEmpty(host, launchPath, ['config', '--get', 'user.email']),
  ]);
  const email = configuredEmail.trim();
  const name = configuredName.trim();

  return {
    email,
    gravatarUrl: email
      ? `https://www.gravatar.com/avatar/${getGravatarHash(email)}?s=80&d=identicon`
      : undefined,
    name,
  };
};

module.exports = {
  listUntrackedItems,
  readDiffSectionContent,
  readDiffImageContent,
  readGitIdentity,
  readRepositoryChangeSignature,
  readWorkingTreeState,
  shouldEagerlyReadWorkingTreeContents,
  splitPatchByPath,
};
