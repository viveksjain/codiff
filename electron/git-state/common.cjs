// @ts-check

const { createHash } = require('node:crypto');
const { isAbsolute, join, normalize, sep } = require('node:path');

/**
 * @typedef {import('../host/repository-host.cjs').HostStat} HostStat
 * @typedef {import('../host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffImageRevision} DiffImageRevision
 * @typedef {import('../../core/types.ts').DiffSection} DiffSection
 * @typedef {import('../../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../core/types.ts').GitFileStatus} GitFileStatus
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('../../core/types.ts').SubmitPullRequestReviewRequest} SubmitPullRequestReviewRequest
 * @typedef {'staged' | 'unstaged'} WorkingTreeSectionKind
 * @typedef {{cacheKey: string; contents: string; name: string}} TextFile
 * @typedef {{reason: string; canLoad?: boolean; fileCount?: number; fingerprint?: string; limit?: number; loadState?: DiffSection['loadState']; size?: number}} DiffSummary
 * @typedef {{binary: boolean; file?: TextFile; fingerprint?: string; loadState?: DiffSection['loadState']; summary?: DiffSummary}} FileContentResult
 * @typedef {{
 *   conflictStage?: 1 | 2 | 3;
 *   directory?: boolean;
 *   oldPath?: string;
 *   path: string;
 *   staged: boolean;
 *   status: GitFileStatus;
 *   summary?: DiffSummary;
 *   unstaged: boolean;
 *   untracked: boolean;
 * }} StatusItem
 * @typedef {{contents?: Buffer; stat: HostStat | undefined}} PrefetchedWorkingTreeFile
 * @typedef {{force?: boolean; patch?: {binary: boolean; patch: string}; patchOnly?: boolean; prefetched?: PrefetchedWorkingTreeFile; showWhitespace?: boolean}} ReadFileOptions
 * @typedef {{number: number; owner: string; repo: string; url: string}} PullRequestReference
 * @typedef {{owner: string; repo: string}} GitHubRemote
 * @typedef {{filename: string; patch?: string; previous_filename?: string; status: string}} GitHubPullRequestFile
 * @typedef {{head?: {sha?: string}; title?: string}} GitHubPullRequestMetadata
 * @typedef {{[key: string]: any}} GitHubReviewComment
 */

/** @param {string | Buffer} value */
const getFingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** @param {string} email */
const getGravatarHash = (email) =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex');

const GIT_MAX_BUFFER = 1024 * 1024 * 64;

/**
 * @param {RepositoryHost} host
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {{encoding?: BufferEncoding}} [options]
 * @returns {Promise<string>}
 */
const git = async (host, repoPath, args, options = {}) =>
  (await host.exec('git', ['-C', repoPath, ...args], { maxBuffer: GIT_MAX_BUFFER })).toString(
    options.encoding || 'utf8',
  );

/** @param {RepositoryHost} host @param {string} repoPath @param {ReadonlyArray<string>} args @returns {Promise<Buffer>} */
const gitBuffer = (host, repoPath, args) =>
  host.exec('git', ['-C', repoPath, ...args], { maxBuffer: GIT_MAX_BUFFER });

/**
 * @param {RepositoryHost} host
 * @param {string} repoPath
 * @param {ReadonlyArray<string>} args
 * @param {string | Buffer} input
 * @param {{env?: Readonly<Record<string, string>>}} [options]
 * @returns {Promise<Buffer>}
 */
const gitBufferWithInput = (host, repoPath, args, input, options = {}) =>
  host.exec('git', ['-C', repoPath, ...args], { env: options.env, input });

const EAGER_TEXT_FILE_LIMIT = 1024 * 1024;
const MANUAL_TEXT_FILE_LIMIT = 2 * 1024 * 1024;
const IMAGE_FILE_LIMIT = 32 * 1024 * 1024;
const MAX_UNTRACKED_INITIAL_ITEMS = 1000;
const imageMimeTypes = new Map([
  ['.apng', 'image/apng'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);
const GENERATED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.next',
  '.parcel-cache',
  '.pnpm-store',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
]);

const generatedDirectoryPathspecExcludes = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  `:(exclude)${name}/**`,
  `:(exclude)**/${name}/**`,
]);

const generatedDirectoryPathspecs = [...GENERATED_DIRECTORY_NAMES].flatMap((name) => [
  name,
  `:(glob)**/${name}/`,
]);

/** @param {{path: string}} left @param {{path: string}} right */
const fileSort = (left, right) => {
  const leftParts = left.path.split('/');
  const rightParts = right.path.split('/');
  const length = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === rightPart) {
      continue;
    }

    const leftIsDirectory = index < leftParts.length - 1;
    const rightIsDirectory = index < rightParts.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return leftPart.localeCompare(rightPart);
  }

  return leftParts.length - rightParts.length;
};

/** @param {string} raw @returns {Array<StatusItem>} */
const parseStatus = (raw) => {
  const parts = raw.split('\0').filter(Boolean);
  const files = new Map();

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    const x = record[0];
    const y = record[1];
    let path = record.slice(3);
    /** @type {string | undefined} */
    let oldPath;

    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      oldPath = parts[++index];
    }

    const current = files.get(path) || {
      oldPath,
      path,
      staged: false,
      status: 'modified',
      unstaged: false,
      untracked: false,
    };

    if (x === '?' && y === '?') {
      current.status = 'untracked';
      current.unstaged = true;
      current.untracked = true;
    } else if (['AA', 'AU', 'DD', 'DU', 'UA', 'UD', 'UU'].includes(`${x}${y}`)) {
      const conflictCode = `${x}${y}`;
      if (conflictCode === 'DD') {
        current.conflictStage = 1;
      } else if (conflictCode !== 'DU' && conflictCode !== 'UA') {
        current.conflictStage = 2;
      }
      current.staged = false;
      current.status = 'conflicted';
      current.unstaged = true;
    } else {
      current.staged = x !== ' ';
      current.unstaged = y !== ' ';

      const statusCode = current.staged ? x : y;
      current.status =
        statusCode === 'A'
          ? 'added'
          : statusCode === 'D'
            ? 'deleted'
            : statusCode === 'R' || statusCode === 'C'
              ? 'renamed'
              : 'modified';
    }

    files.set(path, current);
  }

  return [...files.values()].sort(fileSort);
};

/** @param {Buffer} buffer */
const isBinaryBuffer = (buffer) => buffer.includes(0);

/** @param {number} size */
const formatBytes = (size) => {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ['KiB', 'MiB', 'GiB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    }
    value /= 1024;
  }

  return `${size} B`;
};

/** @param {string} path */
const getImageMimeType = (path) => {
  const dotIndex = path.lastIndexOf('.');
  return dotIndex === -1 ? undefined : imageMimeTypes.get(path.slice(dotIndex).toLowerCase());
};

/**
 * @param {string} path
 * @param {Buffer} buffer
 * @returns {DiffImageRevision}
 */
const bufferToImageRevision = (path, buffer) => {
  const mimeType = getImageMimeType(path);
  if (!mimeType) {
    throw new Error('Unsupported image file type.');
  }

  if (buffer.length > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(buffer.length)}, so Codiff skipped rendering it.`);
  }

  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    name: path,
    size: buffer.length,
  };
};

/** @param {string} reason @param {Partial<DiffSummary>} [details] @returns {DiffSummary} */
const createSummary = (reason, details = {}) => ({
  reason,
  ...details,
});

/** @param {unknown} path */
const validateRepositoryPath = (path) => {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository path.');
  }

  if (path.split(/[\\/]+/u).includes('..')) {
    throw new Error('Invalid repository path.');
  }

  const normalized = normalize(path);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error('Invalid repository path.');
  }

  return normalized;
};

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} path @returns {Promise<HostStat | undefined>} */
const readFileStat = async (host, repoRoot, path) => {
  try {
    return await host.lstat(join(repoRoot, path));
  } catch {
    return undefined;
  }
};

/**
 * Stat many working-tree paths in one host round trip, then read every regular
 * file that fits the eager text limit in a second one. Symlinks and oversized
 * files keep their stat but are not read, matching `readWorkingTreeFile`.
 *
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} paths
 * @returns {Promise<Map<string, PrefetchedWorkingTreeFile>>}
 */
const prefetchWorkingTreeFiles = async (host, repoRoot, paths) => {
  /** @type {Map<string, PrefetchedWorkingTreeFile>} */
  const prefetched = new Map();
  if (paths.length === 0) {
    return prefetched;
  }
  const stats = await host.lstatMany(paths.map((path) => join(repoRoot, path)));
  /** @type {Array<string>} */
  const readablePaths = [];
  paths.forEach((path, index) => {
    const stat = stats[index] ?? undefined;
    prefetched.set(path, { stat });
    if (stat?.type === 'file' && stat.size <= EAGER_TEXT_FILE_LIMIT) {
      readablePaths.push(path);
    }
  });
  if (readablePaths.length > 0) {
    const contents = await host.readFiles(readablePaths.map((path) => join(repoRoot, path)));
    readablePaths.forEach((path, index) => {
      const value = contents[index];
      if (Buffer.isBuffer(value)) {
        prefetched.set(path, { contents: value, stat: prefetched.get(path)?.stat });
      }
    });
  }
  return prefetched;
};

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} spec */
const getBlobSize = async (host, repoRoot, spec) => {
  try {
    return Number((await git(host, repoRoot, ['cat-file', '-s', spec])).trim());
  } catch {
    return undefined;
  }
};

/** @param {string} name @param {Buffer} buffer @param {string} cacheKey @returns {FileContentResult} */
const bufferToTextFile = (name, buffer, cacheKey) => {
  const fingerprint = getFingerprint(buffer);

  if (isBinaryBuffer(buffer)) {
    return {
      binary: true,
      fingerprint,
      file: undefined,
      summary: createSummary('Binary file changed.', {
        canLoad: false,
        fingerprint,
        size: buffer.length,
      }),
    };
  }

  return {
    binary: false,
    file: {
      cacheKey,
      contents: buffer.toString('utf8'),
      name,
    },
  };
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} spec
 * @param {string} path
 * @returns {Promise<DiffImageRevision | undefined>}
 */
const readImageSpec = async (host, repoRoot, spec, path) => {
  const mimeType = getImageMimeType(path);
  if (!mimeType) {
    throw new Error('Unsupported image file type.');
  }

  const size = await getBlobSize(host, repoRoot, spec);
  if (size == null) {
    return undefined;
  }

  if (size > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(size)}, so Codiff skipped rendering it.`);
  }

  try {
    return bufferToImageRevision(path, await gitBuffer(host, repoRoot, ['show', spec]));
  } catch {
    return undefined;
  }
};

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} ref @param {string} path */
const readGitImageFile = (host, repoRoot, ref, path) =>
  readImageSpec(host, repoRoot, `${ref}:${path}`, path);

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} path @param {1 | 2 | 3} [stage] */
const readIndexImageFile = (host, repoRoot, path, stage) =>
  readImageSpec(host, repoRoot, stage ? `:${stage}:${path}` : `:${path}`, path);

/** @param {RepositoryHost} host @param {string} repoRoot @param {string} path */
const readWorkingTreeImageFile = async (host, repoRoot, path) => {
  const mimeType = getImageMimeType(path);
  if (!mimeType) {
    throw new Error('Unsupported image file type.');
  }

  const stat = await readFileStat(host, repoRoot, path);
  if (!stat || stat.type !== 'file') {
    return undefined;
  }

  if (stat.size > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(stat.size)}, so Codiff skipped rendering it.`);
  }

  return bufferToImageRevision(path, await host.readFile(join(repoRoot, path)));
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} ref
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @returns {Promise<FileContentResult>}
 */
const readGitFile = async (host, repoRoot, ref, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const spec = `${ref}:${path}`;

  try {
    const size = await getBlobSize(host, repoRoot, spec);
    if (size != null && size > limit) {
      return {
        binary: false,
        loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(size)} and will be loaded on demand.`,
          {
            canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size,
          },
        ),
      };
    }

    const buffer = await gitBuffer(host, repoRoot, ['show', spec]);
    return bufferToTextFile(path, buffer, `${ref}:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `${ref}:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @param {1 | 2 | 3} [stage]
 * @returns {Promise<FileContentResult>}
 */
const readIndexFile = async (host, repoRoot, path, options = {}, stage) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;
  const spec = stage ? `:${stage}:${path}` : `:${path}`;

  try {
    const size = await getBlobSize(host, repoRoot, spec);
    if (size != null && size > limit) {
      return {
        binary: false,
        loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(size)} and will be loaded on demand.`,
          {
            canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size,
          },
        ),
      };
    }

    const buffer = await gitBuffer(host, repoRoot, ['show', spec]);
    return bufferToTextFile(path, buffer, `index:${path}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `index:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {string} path
 * @param {ReadFileOptions} [options]
 * @returns {Promise<FileContentResult>}
 */
const readWorkingTreeFile = async (host, repoRoot, path, options = {}) => {
  const limit = options.force ? MANUAL_TEXT_FILE_LIMIT : EAGER_TEXT_FILE_LIMIT;

  try {
    const stat = options.prefetched
      ? options.prefetched.stat
      : await readFileStat(host, repoRoot, path);
    if (!stat) {
      throw new Error('File is missing.');
    }

    if (stat.type === 'directory') {
      return {
        binary: false,
        loadState: 'directory',
        summary: createSummary('Untracked directory is collapsed by default.', {
          canLoad: false,
        }),
      };
    }

    if (stat.type === 'symlink') {
      const contents = await host.readlink(join(repoRoot, path));
      const size = Buffer.byteLength(contents);

      if (size > limit) {
        return {
          binary: false,
          loadState: size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
          summary: createSummary(
            size > MANUAL_TEXT_FILE_LIMIT
              ? `Symlink target is ${formatBytes(size)}, so Codiff skipped rendering it.`
              : `Symlink target is ${formatBytes(size)} and will be loaded on demand.`,
            {
              canLoad: size <= MANUAL_TEXT_FILE_LIMIT,
              limit,
              size,
            },
          ),
        };
      }

      return {
        binary: false,
        file: {
          cacheKey: `worktree:${path}:symlink:${contents}`,
          contents,
          name: path,
        },
      };
    }

    if (stat.type !== 'file') {
      return {
        binary: false,
        loadState: 'error',
        summary: createSummary('Path is not a regular file.', {
          canLoad: false,
          size: stat.size,
        }),
      };
    }

    if (stat.size > limit) {
      return {
        binary: false,
        loadState: stat.size > MANUAL_TEXT_FILE_LIMIT ? 'too-large' : 'deferred',
        summary: createSummary(
          stat.size > MANUAL_TEXT_FILE_LIMIT
            ? `File is ${formatBytes(stat.size)}, so Codiff skipped rendering it.`
            : `File is ${formatBytes(stat.size)} and will be loaded on demand.`,
          {
            canLoad: stat.size <= MANUAL_TEXT_FILE_LIMIT,
            limit,
            size: stat.size,
          },
        ),
      };
    }

    const buffer = options.prefetched?.contents ?? (await host.readFile(join(repoRoot, path)));
    return bufferToTextFile(path, buffer, `worktree:${path}:${buffer.length}`);
  } catch {
    return {
      binary: false,
      file: {
        cacheKey: `worktree:${path}:empty`,
        contents: '',
        name: path,
      },
    };
  }
};

/** @param {string} path @param {string} contents */
const createPatchForNewFile = (path, contents) => {
  const trimmed = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  const lines = trimmed.length > 0 ? trimmed.split('\n') : [];
  const body = lines.map((line) => `+${line}`).join('\n');
  const noNewline = contents.endsWith('\n') ? '' : '\n\\ No newline at end of file';

  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ]
    .filter(Boolean)
    .join('\n')
    .concat(noNewline, '\n');
};

/** @param {{showWhitespace?: boolean}} [options] @returns {Array<string>} */
const getWhitespaceDiffArgs = (options = {}) =>
  options.showWhitespace === false ? ['--ignore-all-space'] : [];

/** @param {RepositoryHost} host @param {string} repoRoot @param {StatusItem} item @param {WorkingTreeSectionKind} kind @param {{showWhitespace?: boolean}} [options] */
const getPatch = async (host, repoRoot, item, kind, options = {}) => {
  const whitespaceArgs = getWhitespaceDiffArgs(options);
  if (item.status === 'conflicted' && !item.conflictStage) {
    const newFile = await readWorkingTreeFile(host, repoRoot, item.path, options);
    return {
      binary: newFile.binary,
      patch: newFile.file ? createPatchForNewFile(item.path, newFile.file.contents) : '',
    };
  }
  const args =
    item.status === 'conflicted'
      ? [
          'diff',
          item.conflictStage === 1 ? '--base' : item.conflictStage === 3 ? '--theirs' : '--ours',
          '--patch',
          '--no-ext-diff',
          ...whitespaceArgs,
          '--',
          item.path,
        ]
      : kind === 'staged'
        ? [
            'diff',
            '--cached',
            '--patch',
            '--no-ext-diff',
            ...whitespaceArgs,
            '--',
            ...(item.oldPath ? [item.oldPath] : []),
            item.path,
          ]
        : ['diff', '--patch', '--no-ext-diff', ...whitespaceArgs, '--', item.path];
  const rawPatch = await git(host, repoRoot, args);
  const diffStart = item.status === 'conflicted' ? rawPatch.indexOf('diff --git ') : -1;
  const patch =
    item.status !== 'conflicted' ? rawPatch : diffStart === -1 ? '' : rawPatch.slice(diffStart);

  return {
    binary: /Binary files .* differ/.test(patch),
    patch,
  };
};

/** @param {...FileContentResult} results @returns {{binary: boolean; loadState: DiffSection['loadState']; summary?: DiffSummary}} */
const summarizeContent = (...results) => {
  const binaryResults = results.filter((result) => result.binary);
  if (binaryResults.length > 0) {
    const fingerprint = getFingerprint(
      binaryResults
        .map((result) => `${result.fingerprint || ''}\0${result.summary?.size || ''}`)
        .join('\0'),
    );

    return {
      binary: true,
      loadState: 'binary',
      summary: createSummary('Binary file changed.', {
        canLoad: false,
        fingerprint,
      }),
    };
  }

  const summaryResult = results.find((result) => result.loadState && result.loadState !== 'ready');
  if (summaryResult) {
    return {
      binary: false,
      loadState: summaryResult.loadState,
      summary: summaryResult.summary,
    };
  }

  return {
    binary: false,
    loadState: 'ready',
  };
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {StatusItem} item
 * @param {WorkingTreeSectionKind} kind
 * @param {ReadFileOptions} [options]
 */
const getWorkingTreeContents = async (host, repoRoot, item, kind, options = {}) => {
  if (kind === 'staged') {
    const oldFile = await readGitFile(host, repoRoot, 'HEAD', item.oldPath || item.path, options);
    const newFile = await readIndexFile(host, repoRoot, item.path, options);
    const summary = summarizeContent(oldFile, newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: oldFile.file,
    };
  }

  if (item.untracked) {
    /** @type {FileContentResult} */
    const newFile = item.summary
      ? {
          binary: false,
          loadState: item.summary.loadState,
          summary: item.summary,
        }
      : item.directory
        ? {
            binary: false,
            loadState: 'directory',
            summary: createSummary('Untracked directory is collapsed by default.', {
              canLoad: false,
            }),
          }
        : await readWorkingTreeFile(host, repoRoot, item.path, options);
    const summary = summarizeContent(newFile);

    return {
      ...summary,
      newFile: newFile.file,
      oldFile: {
        cacheKey: `empty:${item.path}`,
        contents: '',
        name: item.path,
      },
    };
  }

  const oldFile = await readIndexFile(host, repoRoot, item.path, options, item.conflictStage);
  const newFile = await readWorkingTreeFile(host, repoRoot, item.path, options);
  const summary = summarizeContent(oldFile, newFile);

  return {
    ...summary,
    newFile: newFile.file,
    oldFile: oldFile.file,
  };
};

/**
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {StatusItem} item
 * @param {WorkingTreeSectionKind} kind
 * @param {ReadFileOptions} [options]
 * @returns {Promise<DiffSection>}
 */
const createSection = async (host, repoRoot, item, kind, options = {}) => {
  const id = `${item.path}:${kind}`;
  const needsWorkingTreeBaseline = item.status === 'conflicted' && !item.conflictStage;

  if (options.patchOnly && !item.untracked && !needsWorkingTreeBaseline) {
    const patch = options.patch ?? (await getPatch(host, repoRoot, item, kind, options));

    if (patch.binary) {
      return {
        binary: true,
        id,
        kind,
        loadState: 'binary',
        patch: '',
        summary: createSummary('Binary file changed.', {
          canLoad: false,
        }),
      };
    }

    return {
      binary: false,
      id,
      kind,
      loadState: 'ready',
      patch: patch.patch,
    };
  }

  const contents = await getWorkingTreeContents(host, repoRoot, item, kind, options);

  if (contents.loadState !== 'ready') {
    return {
      binary: contents.binary,
      id,
      kind,
      loadState: contents.loadState,
      patch: '',
      summary: contents.summary,
    };
  }

  if (item.untracked) {
    return {
      binary: false,
      id,
      kind,
      loadState: 'ready',
      newFile: contents.newFile,
      oldFile: contents.oldFile,
      patch: createPatchForNewFile(item.path, contents.newFile?.contents || ''),
    };
  }

  const patch = await getPatch(host, repoRoot, item, kind, options);

  return {
    binary: patch.binary || contents.binary,
    id,
    kind,
    loadState: 'ready',
    newFile: contents.newFile,
    oldFile: contents.oldFile,
    patch: patch.patch,
  };
};

/** @param {string} statusCode @returns {GitFileStatus} */
const normalizeStatus = (statusCode) =>
  statusCode === 'A'
    ? 'added'
    : statusCode === 'D'
      ? 'deleted'
      : statusCode === 'R' || statusCode === 'C'
        ? 'renamed'
        : 'modified';

/** @param {RepositoryHost} host @param {string} repoRoot @param {ReadonlyArray<string>} args */
const gitOrEmpty = async (host, repoRoot, args) => {
  try {
    return await git(host, repoRoot, args);
  } catch {
    return '';
  }
};

module.exports = {
  EAGER_TEXT_FILE_LIMIT,
  IMAGE_FILE_LIMIT,
  MANUAL_TEXT_FILE_LIMIT,
  MAX_UNTRACKED_INITIAL_ITEMS,
  bufferToTextFile,
  bufferToImageRevision,
  createSection,
  createSummary,
  fileSort,
  formatBytes,
  generatedDirectoryPathspecExcludes,
  generatedDirectoryPathspecs,
  getFingerprint,
  getGravatarHash,
  getImageMimeType,
  getWhitespaceDiffArgs,
  git,
  gitBufferWithInput,
  gitOrEmpty,
  normalizeStatus,
  parseStatus,
  prefetchWorkingTreeFiles,
  readFileStat,
  readGitFile,
  readGitImageFile,
  readIndexImageFile,
  readWorkingTreeImageFile,
  summarizeContent,
  validateRepositoryPath,
};
