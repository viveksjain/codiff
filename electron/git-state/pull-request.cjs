// @ts-check

const { spawn } = require('node:child_process');
const { homedir } = require('node:os');
const { join } = require('node:path');
const { findExecutableOnPath, isExecutableFile } = require('../agent-shared.cjs');
const { getCommandEnvironment } = require('../login-shell-environment.cjs');
const {
  IMAGE_FILE_LIMIT,
  MANUAL_TEXT_FILE_LIMIT,
  bufferToImageRevision,
  bufferToTextFile,
  createSummary,
  formatBytes,
  getFingerprint,
  getImageMimeType,
  git,
  gitOrEmpty,
  summarizeContent,
  validateRepositoryPath,
} = require('./common.cjs');
const { createEmptyFileContent } = require('./git-files.cjs');
const { parseReviewUrl } = require('../review-source.cjs');

/**
 * @typedef {import('../host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../../core/types.ts').ChangedFile} ChangedFile
 * @typedef {import('../../core/types.ts').DiffImageContentResult} DiffImageContentResult
 * @typedef {import('../../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../core/types.ts').GitFileStatus} GitFileStatus
 * @typedef {import('../../core/types.ts').PullRequestReviewComment} PullRequestReviewComment
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {import('../../core/types.ts').ReviewSource} ReviewSource
 * @typedef {import('../../core/types.ts').SubmitPullRequestCommentRequest} SubmitPullRequestCommentRequest
 * @typedef {import('../../core/types.ts').SubmitPullRequestReviewRequest} SubmitPullRequestReviewRequest
 * @typedef {{owner: string; repo: string}} GitHubRepositoryReference
 * @typedef {{name: string; url: string}} LocalGitRemote
 * @typedef {{full_name?: string; name?: string; owner?: {login?: string}}} GitHubRepositoryMetadata
 * @typedef {{number: number; owner: string; repo: string; url: string}} PullRequestReference
 * @typedef {{direction: 'fetch' | 'push'; name: string; owner: string; repo: string}} GitHubRemote
 * @typedef {{filename: string; patch?: string; previous_filename?: string; status: string}} GitHubPullRequestFile
 * @typedef {{base?: {ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string}; body?: string | null; head?: {ref?: string; repo?: GitHubRepositoryMetadata | null; sha?: string}; title?: string; user?: {avatar_url?: string; html_url?: string; login?: string}}} GitHubPullRequestMetadata
 * @typedef {{author?: {avatar_url?: string}; commit?: {author?: {date?: string; email?: string; name?: string}; message?: string}; parents?: ReadonlyArray<{sha?: string}>; sha?: string}} GitHubCommit
 * @typedef {{[key: string]: any}} GitHubReviewComment
 * @typedef {{comments?: {nodes?: ReadonlyArray<{databaseId?: number | null}>} | null; isResolved?: boolean}} GitHubReviewThread
 */

const GH_NOT_FOUND_CODE = 'GH_NOT_FOUND';
const GH_NOT_FOUND_MESSAGE =
  'GitHub support requires gh. Install gh, authenticate it, and verify `gh --version` works in Terminal. Codiff searches PATH, ~/.local/bin/gh, /opt/homebrew/bin/gh, and /usr/local/bin/gh. If gh is installed somewhere else, quit Codiff, then launch it with `CODIFF_GH_PATH=/absolute/path/to/gh codiff`.';

/** @param {string} [detail] */
const createGhNotFoundError = (detail) =>
  Object.assign(new Error(detail ? `${GH_NOT_FOUND_MESSAGE} ${detail}` : GH_NOT_FOUND_MESSAGE), {
    code: GH_NOT_FOUND_CODE,
  });

/**
 * A Dock or Spotlight launch gives the app a minimal PATH that omits the
 * directories Homebrew and manual installs use, and later `codiff` invocations
 * hand their arguments to that first process rather than replacing it, so `gh`
 * has to be located the same way the other CLIs Codiff shells out to are.
 */
const getGhCommand = () => {
  const ghPath = process.env.CODIFF_GH_PATH?.trim();
  if (ghPath) {
    if (isExecutableFile(ghPath)) {
      return ghPath;
    }

    throw createGhNotFoundError(
      `CODIFF_GH_PATH is set to ${JSON.stringify(ghPath)}, but that file is not executable.`,
    );
  }

  const pathCommand = findExecutableOnPath('gh');
  if (pathCommand) {
    return pathCommand;
  }

  for (const path of [
    join(homedir(), '.local/bin/gh'),
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
  ]) {
    if (isExecutableFile(path)) {
      return path;
    }
  }

  throw createGhNotFoundError();
};

/** @param {string} value @returns {PullRequestReference} */
const parseGitHubPullRequestUrl = (value) => {
  const parsed = parseReviewUrl(value);
  if (!parsed) {
    throw new Error('Codiff expected a GitHub pull request URL.');
  }

  if (parsed.provider !== 'github') {
    throw new Error('Codiff only supports GitHub pull request URLs.');
  }

  return {
    number: parsed.number,
    owner: parsed.owner,
    repo: parsed.repo,
    url: parsed.url,
  };
};

/** @param {string} value @returns {GitHubRepositoryReference | null} */
const parseGitHubRemoteUrl = (value) => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^(?:git|org-\d+)@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== 'github.com') {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, ''),
        }
      : null;
  } catch {
    return null;
  }
};

/** @param {string} value @returns {GitHubRepositoryReference | null} */
const parseRemoteRepositoryPath = (value) => {
  const trimmed = value.trim();
  const sshMatch = trimmed.match(/^(?:[^@\s/:]+@)?[^/\s:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2].replace(/\.git$/i, ''),
    };
  }

  try {
    const url = new URL(trimmed);
    if (!['git:', 'http:', 'https:', 'ssh:'].includes(url.protocol)) {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
    return match
      ? {
          owner: match[1],
          repo: match[2].replace(/\.git$/i, '').replace(/\/$/, ''),
        }
      : null;
  } catch {
    return null;
  }
};

/** @param {RepositoryHost} host @param {string} repoRoot @returns {Promise<Array<LocalGitRemote>>} */
const readLocalGitRemotes = async (host, repoRoot) => {
  const names = (await gitOrEmpty(host, repoRoot, ['remote']))
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
  const remotes = await Promise.all(
    names.map(async (name) => {
      // Read the configured URL instead of `git remote -v`, which applies
      // `insteadOf` rewrites and can hide the original github.com host.
      const url = (await gitOrEmpty(host, repoRoot, ['config', '--get', `remote.${name}.url`]))
        .split('\n')[0]
        .trim();
      return url ? { name, url } : null;
    }),
  );
  return remotes.filter((remote) => remote != null);
};

/** @param {LocalGitRemote} remote */
const getRemotePriority = (remote) => (remote.name === 'origin' ? 0 : 1);

/**
 * Let Git resolve SSH aliases, credential helpers, and URL rewrites, then make
 * sure the candidate remote exposes this exact GitHub pull request head.
 *
 * @param {RepositoryHost} host
 * @param {string} repoRoot
 * @param {LocalGitRemote} remote
 * @param {PullRequestReference} pullRequest
 * @param {string} expectedHeadSha
 */
const remoteHasPullRequestHead = async (host, repoRoot, remote, pullRequest, expectedHeadSha) => {
  const headRef = `refs/pull/${pullRequest.number}/head`;
  const output = await gitOrEmpty(host, repoRoot, ['ls-remote', '--refs', remote.name, headRef]);
  return output.split('\n').some((line) => {
    const [sha, ref] = line.trim().split(/\s+/);
    return ref === headRef && sha?.toLowerCase() === expectedHeadSha.toLowerCase();
  });
};

/** @param {RepositoryHost} host @param {string} repoRoot @param {PullRequestReference} pullRequest @param {string | undefined} expectedHeadSha @returns {Promise<GitHubRemote>} */
const selectPullRequestRemote = async (host, repoRoot, pullRequest, expectedHeadSha) => {
  const remotes = (await readLocalGitRemotes(host, repoRoot)).sort(
    (left, right) => getRemotePriority(left) - getRemotePriority(right),
  );
  const remote = remotes
    .map((remote) => ({ remote, repository: parseGitHubRemoteUrl(remote.url) }))
    .filter(
      ({ repository }) =>
        repository?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
        repository.repo.toLowerCase() === pullRequest.repo.toLowerCase(),
    )[0]?.remote;

  if (remote) {
    return {
      direction: 'fetch',
      name: remote.name,
      owner: pullRequest.owner,
      repo: pullRequest.repo,
    };
  }

  if (expectedHeadSha) {
    const candidates = remotes.filter(({ url }) => {
      const repository = parseRemoteRepositoryPath(url);
      return (
        repository?.owner.toLowerCase() === pullRequest.owner.toLowerCase() &&
        repository.repo.toLowerCase() === pullRequest.repo.toLowerCase()
      );
    });

    for (const candidate of candidates) {
      if (await remoteHasPullRequestHead(host, repoRoot, candidate, pullRequest, expectedHeadSha)) {
        return {
          direction: 'fetch',
          name: candidate.name,
          owner: pullRequest.owner,
          repo: pullRequest.repo,
        };
      }
    }
  }

  throw new Error(
    `Pull request ${pullRequest.owner}/${pullRequest.repo} does not match a GitHub remote in this repository.`,
  );
};

/**
 * Runs `gh api` and reports how it exited. Callers decide which exit codes are
 * failures because a missing file is a valid answer for content lookups.
 *
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @returns {Promise<{code: number | null; stderr: string; stdout: Buffer}>}
 */
const runGhApi = async (repoRoot, args, input) => {
  const environment = await getCommandEnvironment();
  return new Promise((resolve, reject) => {
    const child = spawn(getGhCommand(), ['api', ...args], {
      cwd: repoRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Array<Buffer>} */
    const stdout = [];
    /** @type {Array<Buffer>} */
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => reject(error.code === 'ENOENT' ? createGhNotFoundError() : error));
    child.on('close', (code) =>
      resolve({
        code,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout),
      }),
    );

    child.stdin.end(input == null ? undefined : JSON.stringify(input));
  });
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @param {unknown} [input]
 * @returns {Promise<string>}
 */
const ghApi = async (repoRoot, args, input) => {
  const { code, stderr, stdout } = await runGhApi(repoRoot, args, input);
  if (code === 0) {
    return stdout.toString('utf8');
  }

  throw new Error(stderr.trim() || `gh api exited with code ${code}.`);
};

/**
 * @param {string} repoRoot
 * @param {ReadonlyArray<string>} args
 * @returns {Promise<Buffer | undefined>}
 */
const ghApiBuffer = async (repoRoot, args) => {
  const { code, stderr, stdout } = await runGhApi(repoRoot, args);
  if (code === 0) {
    return stdout;
  }

  if (code === 1 && /not found|404/i.test(stderr)) {
    return undefined;
  }

  throw new Error(stderr.trim() || `gh api exited with code ${code}.`);
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<GitHubPullRequestMetadata>} */
const readPullRequestMetadata = async (repoRoot, pullRequest) =>
  JSON.parse(
    await ghApi(repoRoot, [
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
    ]),
  );

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<Array<GitHubPullRequestFile>>} */
const readPullRequestFiles = async (repoRoot, pullRequest) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/files?per_page=100`,
    ]),
  );
  return pages.flat();
};

/** @param {string} path */
const encodeGitHubContentPath = (path) => path.split('/').map(encodeURIComponent).join('/');

/** @param {GitHubRepositoryMetadata | null | undefined} repository */
const normalizeGitHubRepositoryReference = (repository) => {
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (owner && repo) {
    return { owner, repo };
  }

  const [fullNameOwner, fullNameRepo] = repository?.full_name?.split('/') ?? [];
  return fullNameOwner && fullNameRepo
    ? {
        owner: fullNameOwner,
        repo: fullNameRepo,
      }
    : null;
};

/** @param {PullRequestReference} pullRequest @param {GitHubPullRequestMetadata} metadata */
const getPullRequestHeadImageSource = (pullRequest, metadata) => {
  const repository = normalizeGitHubRepositoryReference(metadata.head?.repo);
  return {
    owner: repository?.owner ?? pullRequest.owner,
    ref: repository
      ? (metadata.head?.sha ?? metadata.head?.ref ?? 'HEAD')
      : `refs/pull/${pullRequest.number}/head`,
    repo: repository?.repo ?? pullRequest.repo,
  };
};

/**
 * @param {string} repoRoot
 * @param {GitHubRepositoryReference} repository
 * @param {string} ref
 * @param {string} path
 */
const readGitHubImageFile = async (repoRoot, repository, ref, path) => {
  if (!getImageMimeType(path)) {
    throw new Error('Unsupported image file type.');
  }

  const buffer = await ghApiBuffer(repoRoot, [
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${repository.owner}/${repository.repo}/contents/${encodeGitHubContentPath(
      path,
    )}?ref=${encodeURIComponent(ref)}`,
  ]);

  if (!buffer) {
    return undefined;
  }

  if (buffer.length > IMAGE_FILE_LIMIT) {
    throw new Error(`Image is ${formatBytes(buffer.length)}, so Codiff skipped rendering it.`);
  }

  return bufferToImageRevision(path, buffer);
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const readPullRequestDiff = async (repoRoot, pullRequest) =>
  ghApi(repoRoot, [
    '-H',
    'Accept: application/vnd.github.v3.diff',
    `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}`,
  ]);

/** @param {unknown} side */
const fromGitHubReviewSide = (side) => (side === 'LEFT' ? 'deletions' : 'additions');
/** @param {unknown} side */
const isGitHubReviewSide = (side) => side === 'LEFT' || side === 'RIGHT';

/** @param {...unknown} values */
const firstNumber = (...values) => values.find((value) => typeof value === 'number');

/** @param {GitHubReviewComment} comment */
const normalizeGitHubReviewComment = (comment) => {
  const lineNumber = firstNumber(comment.line, comment.original_line);
  if (lineNumber == null || !comment.path || !comment.body) {
    return null;
  }

  const side = fromGitHubReviewSide(comment.side);
  const startLineNumber = firstNumber(comment.start_line, comment.original_start_line);
  const startSide = isGitHubReviewSide(comment.start_side)
    ? fromGitHubReviewSide(comment.start_side)
    : undefined;
  const hasRange =
    startLineNumber != null && (startLineNumber !== lineNumber || (startSide ?? side) !== side);

  return {
    author: {
      avatarUrl: comment.user?.avatar_url,
      login: comment.user?.login || 'GitHub user',
      url: comment.user?.html_url,
    },
    body: comment.body,
    filePath: comment.path,
    id: `github:${comment.id}`,
    ...(typeof comment.line !== 'number' ? { isOutdated: true } : {}),
    lineNumber,
    side,
    ...(hasRange ? { startLineNumber } : {}),
    ...(hasRange && startSide != null && startSide !== side ? { startSide } : {}),
    submittedAt: comment.created_at,
    url: comment.html_url,
  };
};

/** @param {ReadonlyArray<GitHubReviewThread>} threads @returns {Set<number>} */
const collectResolvedReviewCommentIds = (threads) => {
  /** @type {Set<number>} */
  const ids = new Set();
  for (const thread of threads) {
    if (!thread?.isResolved) {
      continue;
    }
    for (const comment of thread.comments?.nodes ?? []) {
      if (typeof comment?.databaseId === 'number') {
        ids.add(comment.databaseId);
      }
    }
  }
  return ids;
};

/** @param {ReadonlyArray<GitHubReviewComment>} comments @param {ReadonlySet<number>} resolvedCommentIds */
const selectUnresolvedReviewComments = (comments, resolvedCommentIds) =>
  comments
    .filter((comment) => !resolvedCommentIds.has(comment.id))
    .map(normalizeGitHubReviewComment)
    .filter(Boolean);

const RESOLVED_REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          comments(first: 100) {
            nodes {
              databaseId
            }
          }
          isResolved
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
}`;

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<Set<number>>} */
const readResolvedReviewCommentIds = async (repoRoot, pullRequest) => {
  try {
    /** @type {Array<GitHubReviewThread>} */
    const threads = [];
    /** @type {string | undefined} */
    let cursor;
    let hasNextPage = true;
    while (hasNextPage) {
      const response = JSON.parse(
        await ghApi(repoRoot, [
          'graphql',
          '-f',
          `query=${RESOLVED_REVIEW_THREADS_QUERY}`,
          '-f',
          `owner=${pullRequest.owner}`,
          '-f',
          `repo=${pullRequest.repo}`,
          '-F',
          `number=${pullRequest.number}`,
          ...(cursor ? ['-f', `cursor=${cursor}`] : []),
        ]),
      );
      const reviewThreads = response?.data?.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) {
        break;
      }
      if (Array.isArray(reviewThreads.nodes)) {
        threads.push(...reviewThreads.nodes);
      }
      cursor = reviewThreads.pageInfo?.endCursor ?? undefined;
      hasNextPage = Boolean(reviewThreads.pageInfo?.hasNextPage && cursor);
    }
    return collectResolvedReviewCommentIds(threads);
  } catch {
    return new Set();
  }
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const readPullRequestComments = async (repoRoot, pullRequest) => {
  const [pages, resolvedCommentIds] = await Promise.all([
    ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments?per_page=100`,
    ]).then((output) => JSON.parse(output)),
    readResolvedReviewCommentIds(repoRoot, pullRequest),
  ]);
  return selectUnresolvedReviewComments(pages.flat(), resolvedCommentIds);
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @returns {Promise<Array<GitHubCommit>>} */
const readPullRequestCommits = async (repoRoot, pullRequest) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/commits?per_page=100`,
    ]),
  );
  return pages.flat();
};

/** @param {string} repoRoot @param {PullRequestReference} pullRequest @param {string} sha @param {number} limit @returns {Promise<Array<GitHubCommit>>} */
const readRepositoryCommits = async (repoRoot, pullRequest, sha, limit) => {
  /** @type {Array<GitHubCommit>} */
  const commits = [];
  for (let page = 1; commits.length < limit; page += 1) {
    const pageCommits = JSON.parse(
      await ghApi(repoRoot, [
        `repos/${pullRequest.owner}/${pullRequest.repo}/commits?sha=${encodeURIComponent(
          sha,
        )}&per_page=${Math.min(limit - commits.length, 100)}&page=${page}`,
      ]),
    );
    if (!Array.isArray(pageCommits) || pageCommits.length === 0) {
      break;
    }
    commits.push(...pageCommits);
  }
  return commits;
};

/** @param {GitHubCommit} commit @param {'base' | 'pull-request'} [scope] */
const normalizeGitHubCommit = (commit, scope) => {
  const ref = commit.sha;
  const committedAt = Date.parse(commit.commit?.author?.date || '');
  const message = commit.commit?.message || '';
  if (!ref || !message || !Number.isFinite(committedAt)) {
    return null;
  }

  return {
    author: commit.commit?.author?.name || '',
    committedAt,
    gravatarUrl: commit.author?.avatar_url,
    parents: commit.parents?.map((parent) => parent.sha).filter(Boolean) || [],
    ref,
    ...(scope ? { scope } : {}),
    subject: message.split('\n')[0],
  };
};

/** @param {GitHubCommit} commit */
const normalizeGitHubPullRequestCommit = (commit) => normalizeGitHubCommit(commit, 'pull-request');

/** @param {RepositoryHost} host @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @param {number} [limit] */
const listPullRequestHistory = async (host, launchPath, source, limit = 200) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  const [metadata, commits] = await Promise.all([
    readPullRequestMetadata(repoRoot, pullRequest),
    readPullRequestCommits(repoRoot, pullRequest),
  ]);
  await selectPullRequestRemote(host, repoRoot, pullRequest, metadata.head?.sha);
  const baseCommits = metadata.base?.sha
    ? await readRepositoryCommits(repoRoot, pullRequest, metadata.base.sha, limit)
    : [];
  /** @param {GitHubCommit} commit @param {'base' | 'pull-request'} scope @param {GitHubRepositoryReference} repository */
  const withSource = (commit, scope, repository) => {
    const entry = normalizeGitHubCommit(commit, scope);
    return entry
      ? {
          ...entry,
          source: { github: repository, ref: entry.ref, type: /** @type {const} */ ('commit') },
        }
      : null;
  };
  const headRepository = normalizeGitHubRepositoryReference(metadata.head?.repo) ?? pullRequest;
  return {
    entries: [
      ...commits
        .map((commit) => withSource(commit, 'pull-request', headRepository))
        .filter(Boolean)
        .reverse(),
      ...baseCommits.map((commit) => withSource(commit, 'base', pullRequest)).filter(Boolean),
    ],
    root: repoRoot,
  };
};

/** @param {string} diff @returns {Map<string, string>} */
const splitPullRequestDiff = (diff) => {
  const chunks = diff
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trimEnd())
    .filter((chunk) => chunk.startsWith('diff --git '));
  const map = new Map();

  for (const chunk of chunks) {
    const newPath = chunk.match(/^\+\+\+\s+b\/(.+)$/m)?.[1];
    const oldPath = chunk.match(/^---\s+a\/(.+)$/m)?.[1];
    const renamePath = chunk.match(/^rename to (.+)$/m)?.[1];
    const path = newPath && newPath !== '/dev/null' ? newPath : renamePath || oldPath;
    if (path) {
      map.set(path, `${chunk}\n`);
    }
  }

  return map;
};

/** @param {string} path */
const quotePatchPath = (path) => path.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** @param {GitHubPullRequestFile} file */
const createPatchFromPullRequestFile = (file) => {
  if (!file.patch) {
    return '';
  }

  const oldPath = file.previous_filename || file.filename;
  const header = [
    `diff --git a/${quotePatchPath(oldPath)} b/${quotePatchPath(file.filename)}`,
    file.status === 'added' ? '--- /dev/null' : `--- a/${quotePatchPath(oldPath)}`,
    file.status === 'removed' ? '+++ /dev/null' : `+++ b/${quotePatchPath(file.filename)}`,
  ];

  return `${header.join('\n')}\n${file.patch}\n`;
};

/** @param {string} status @returns {GitFileStatus} */
const normalizePullRequestFileStatus = (status) =>
  status === 'added'
    ? 'added'
    : status === 'removed'
      ? 'deleted'
      : status === 'renamed'
        ? 'renamed'
        : 'modified';

/** @param {PullRequestReference} pullRequest @param {GitHubPullRequestMetadata} metadata @returns {Extract<ReviewSource, {type: 'pull-request'}>} */
const createPullRequestSource = (pullRequest, metadata) => ({
  ...(metadata.user?.login
    ? {
        author: {
          avatarUrl: metadata.user.avatar_url,
          login: metadata.user.login,
          url: metadata.user.html_url,
        },
      }
    : {}),
  ...(metadata.body?.trim() ? { description: metadata.body.trim() } : {}),
  baseSha: metadata.base?.sha,
  headRepository: normalizeGitHubRepositoryReference(metadata.head?.repo) ?? {
    owner: pullRequest.owner,
    repo: pullRequest.repo,
  },
  headSha: metadata.head?.sha,
  host: 'github.com',
  number: pullRequest.number,
  owner: pullRequest.owner,
  projectPath: `${pullRequest.owner}/${pullRequest.repo}`,
  provider: 'github',
  repo: pullRequest.repo,
  title: metadata.title,
  type: 'pull-request',
  url: pullRequest.url,
});

/**
 * git/GitHub emit `Binary files a/x and b/x differ` as a diff metadata line.
 * Anchor to the start of a line so the same text appearing inside a patch's
 * added/removed/context lines (which are prefixed with `+`/`-`/space) does not
 * misclassify a text file as binary.
 */
const BINARY_DIFF_MARKER = /^Binary files .* differ/m;

/**
 * Build a diff section for a pull request file. When the full base and head
 * contents are available the section carries `oldFile`/`newFile` so Codiff
 * renders a recomputed diff with expandable unmodified context (matching commits
 * and the working tree). Otherwise it falls back to the GitHub patch.
 *
 * @param {string} id
 * @param {'commit' | 'pull-request'} kind
 * @param {GitHubPullRequestFile} file
 * @param {string} patch
 * @param {import('./common.cjs').FileContentResult} [oldFile]
 * @param {import('./common.cjs').FileContentResult} [newFile]
 * @returns {import('../../core/types.ts').DiffSection}
 */
const createGitHubSection = (id, kind, file, patch, oldFile, newFile) => {
  const patchBinary = !patch || BINARY_DIFF_MARKER.test(patch);
  // Expandable context can only be rendered when both sides' contents are present.
  const attemptedContent = oldFile != null && newFile != null;

  if (attemptedContent && !patchBinary) {
    const summary = summarizeContent(oldFile, newFile);
    const status = normalizePullRequestFileStatus(file.status);
    const oldContents = oldFile.file?.contents ?? '';
    const newContents = newFile.file?.contents ?? '';
    // A modification that reads empty on both sides means the content failed to
    // load; keep the patch instead of rendering it as an empty (no-op) diff.
    const contentMissing =
      (status === 'modified' || status === 'renamed') && oldContents === '' && newContents === '';

    if (!summary.binary && summary.loadState === 'ready' && !contentMissing) {
      return {
        binary: false,
        id,
        kind,
        loadState: 'ready',
        newFile: newFile.file,
        oldFile: oldFile.file,
        patch,
      };
    }
  }

  // Text patches hydrate only when the user expands unchanged context.
  return {
    binary: patchBinary,
    id,
    kind,
    loadState: patchBinary ? 'binary' : 'ready',
    patch,
    summary: createSummary(
      patchBinary ? 'Binary file changed.' : 'Showing the pull request patch for this file.',
      { canLoad: !patchBinary && !attemptedContent },
    ),
  };
};

/** @param {PullRequestReference} pullRequest @param {GitHubPullRequestFile} file @param {string} patch @param {import('./common.cjs').FileContentResult} [oldFile] @param {import('./common.cjs').FileContentResult} [newFile] */
const createPullRequestSection = (pullRequest, file, patch, oldFile, newFile) =>
  createGitHubSection(
    `${file.filename}:pull-request:${pullRequest.number}`,
    'pull-request',
    file,
    patch,
    oldFile,
    newFile,
  );

/** @param {RepositoryHost} host @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @returns {Promise<RepositoryState>} */
const readPullRequestState = async (host, launchPath, source) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(source.url);

  /** @template T @param {string} operation @param {Promise<T>} request @returns {Promise<T>} */
  const withContext = async (operation, request) => {
    try {
      return await request;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to load PR ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}: failed to read ${operation}.\n\n${detail}\n\nCheck GitHub access with: gh pr view ${pullRequest.url}`,
        { cause: error },
      );
    }
  };
  const [metadata, apiFiles, diff, reviewComments] = await Promise.all([
    withContext('metadata', readPullRequestMetadata(repoRoot, pullRequest)),
    withContext('changed files', readPullRequestFiles(repoRoot, pullRequest)),
    withContext('diff', readPullRequestDiff(repoRoot, pullRequest)),
    withContext('review comments', readPullRequestComments(repoRoot, pullRequest)),
  ]);
  await selectPullRequestRemote(host, repoRoot, pullRequest, metadata.head?.sha);
  const diffByPath = splitPullRequestDiff(diff);
  const reviewFiles = [...apiFiles].map((file) => {
    const patch = diffByPath.get(file.filename) || createPatchFromPullRequestFile(file);
    return {
      file,
      oldPath: file.previous_filename || file.filename,
      patch,
    };
  });
  /** @type {Array<ChangedFile>} */
  const files = reviewFiles
    .map(({ file, patch }) => {
      const section = createPullRequestSection(pullRequest, file, patch);

      return {
        fingerprint: getFingerprint(
          [
            metadata.head?.sha || '',
            file.status,
            file.previous_filename || '',
            file.filename,
            section.loadState || 'ready',
            section.oldFile?.cacheKey || '',
            section.newFile?.cacheKey || '',
            patch,
          ].join('\n'),
        ),
        oldPath: file.previous_filename,
        path: file.filename,
        sections: [section],
        status: normalizePullRequestFileStatus(file.status),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    files,
    generatedAt: Date.now(),
    launchPath,
    reviewComments,
    root: repoRoot,
    source: createPullRequestSource(pullRequest, metadata),
  };
};

/** @param {string} repoRoot @param {GitHubRepositoryReference} repository @param {string} ref @param {string} path */
const readGitHubTextFile = async (repoRoot, repository, ref, path) => {
  const buffer = await ghApiBuffer(repoRoot, [
    '-H',
    'Accept: application/vnd.github.raw',
    `repos/${repository.owner}/${repository.repo}/contents/${encodeGitHubContentPath(path)}?ref=${encodeURIComponent(ref)}`,
  ]);
  if (!buffer) {
    throw new Error(`Codiff could not load ${path} from GitHub at ${ref}.`);
  }
  if (buffer.length > MANUAL_TEXT_FILE_LIMIT) {
    throw new Error(
      `File is ${formatBytes(buffer.length)}, so Codiff skipped loading full context.`,
    );
  }
  return bufferToTextFile(path, buffer, `${repository.owner}/${repository.repo}:${ref}:${path}`);
};

/** @param {RepositoryHost} host @param {string} launchPath @param {Extract<ReviewSource, {type: 'pull-request'}>} source @param {string} requestedPath @param {DiffSectionContentRequest['file']} [snapshotFile] */
const readPullRequestSectionContent = async (
  host,
  launchPath,
  source,
  requestedPath,
  snapshotFile,
) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const path = validateRepositoryPath(requestedPath);
  const pullRequest = parseGitHubPullRequestUrl(source.url);
  const [metadata, files] = await Promise.all([
    source.baseSha && source.headSha
      ? Promise.resolve(null)
      : readPullRequestMetadata(repoRoot, pullRequest),
    snapshotFile
      ? Promise.resolve([
          {
            filename: path,
            previous_filename: snapshotFile.oldPath,
            status: snapshotFile.status === 'deleted' ? 'removed' : snapshotFile.status,
          },
        ])
      : readPullRequestFiles(repoRoot, pullRequest),
  ]);
  const base = source.baseSha ?? metadata?.base?.sha;
  const head = source.headSha ?? metadata?.head?.sha;
  if (!base || !head) {
    throw new Error('Codiff could not resolve the pull request commits from GitHub.');
  }
  // A displayed snapshot was validated when it opened. Rechecking an opaque
  // remote's live PR head would reject that snapshot after a subsequent push.
  if (!snapshotFile || !source.baseSha || !source.headSha) {
    await selectPullRequestRemote(host, repoRoot, pullRequest, head);
  }
  const file = files.find((candidate) => candidate.filename === path);
  if (!file) {
    throw new Error('File is not part of this pull request.');
  }

  // GitHub's PR patch starts at the merge base, which can predate base.sha.
  // Resolve it through the API only when full context is actually requested.
  const comparison = JSON.parse(
    await ghApi(repoRoot, [
      `repos/${pullRequest.owner}/${pullRequest.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
    ]),
  );
  const mergeBase = comparison.merge_base_commit?.sha;
  if (!mergeBase) {
    throw new Error('Codiff could not resolve the pull request merge base from GitHub.');
  }
  const headRepository =
    source.headRepository ??
    normalizeGitHubRepositoryReference(metadata?.head?.repo) ??
    pullRequest;
  const oldPath = file.previous_filename || file.filename;
  const [oldFile, newFile] = await Promise.all([
    file.status === 'added'
      ? createEmptyFileContent(oldPath, mergeBase, true)
      : readGitHubTextFile(repoRoot, pullRequest, mergeBase, oldPath),
    file.status === 'removed'
      ? createEmptyFileContent(file.filename, head, true)
      : readGitHubTextFile(repoRoot, headRepository, head, file.filename),
  ]);
  return createPullRequestSection(
    pullRequest,
    file,
    snapshotFile?.patch ?? createPatchFromPullRequestFile(file),
    oldFile,
    newFile,
  );
};

/**
 * @param {RepositoryHost} host
 * @param {string} launchPath
 * @param {Extract<ReviewSource, {type: 'pull-request'}>} source
 * @param {string} requestedPath
 * @returns {Promise<DiffImageContentResult>}
 */
const readPullRequestImageContent = async (host, launchPath, source, requestedPath) => {
  try {
    const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const path = validateRepositoryPath(requestedPath);
    const pullRequest = parseGitHubPullRequestUrl(source.url);

    const [metadata, files] = await Promise.all([
      readPullRequestMetadata(repoRoot, pullRequest),
      readPullRequestFiles(repoRoot, pullRequest),
    ]);
    await selectPullRequestRemote(host, repoRoot, pullRequest, metadata.head?.sha);
    const file = files.find((candidate) => candidate.filename === path);
    if (!file) {
      throw new Error('File is not part of this pull request.');
    }

    const headImageSource = getPullRequestHeadImageSource(pullRequest, metadata);
    const [oldImage, newImage] = await Promise.all([
      metadata.base?.sha
        ? readGitHubImageFile(
            repoRoot,
            pullRequest,
            metadata.base.sha,
            file.previous_filename || file.filename,
          )
        : undefined,
      readGitHubImageFile(repoRoot, headImageSource, headImageSource.ref, file.filename),
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

/** @param {PullRequestReviewComment['side']} side */
const toGitHubReviewSide = (side) => (side === 'deletions' ? 'LEFT' : 'RIGHT');

/** @param {PullRequestReviewComment} comment */
const normalizePullRequestComment = (comment) => {
  /** @type {{body: string; line: number; path: string; side: string; start_line?: number; start_side?: string}} */
  const payload = {
    body: comment.body,
    line: comment.lineNumber,
    path: comment.filePath,
    side: toGitHubReviewSide(comment.side),
  };
  const startSide = comment.startSide ?? comment.side;
  if (
    typeof comment.startLineNumber === 'number' &&
    comment.startLineNumber !== comment.lineNumber
  ) {
    payload.start_line = comment.startLineNumber;
    payload.start_side = toGitHubReviewSide(startSide);
  }
  return payload;
};

const PENDING_REVIEW_COMMENT_ERROR =
  'You already have a pending GitHub review on this pull request. Submit or discard it on GitHub, then retry. Your comment draft is still here.';

/** @param {unknown} error */
const isGitHubValidationError = (error) =>
  error instanceof Error && /(?:validation failed|http 422)/i.test(error.message);

/** @param {string} repoRoot @param {PullRequestReference} pullRequest */
const hasPendingPullRequestReview = async (repoRoot, pullRequest) => {
  const pages = JSON.parse(
    await ghApi(repoRoot, [
      '--paginate',
      '--slurp',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews?per_page=100`,
    ]),
  );
  return Array.isArray(pages) && pages.flat().some((review) => review?.state === 'PENDING');
};

/** @param {RepositoryHost} host @param {string} launchPath @param {SubmitPullRequestCommentRequest} request */
const submitPullRequestComment = async (host, launchPath, request) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  await selectPullRequestRemote(host, repoRoot, pullRequest, metadata.head?.sha);
  const payload = {
    ...normalizePullRequestComment(request.comment),
    commit_id: metadata.head?.sha,
  };

  const rawComment = await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/comments`,
      '--input',
      '-',
    ],
    payload,
  ).catch(async (error) => {
    if (isGitHubValidationError(error)) {
      const hasPendingReview = await hasPendingPullRequestReview(repoRoot, pullRequest).catch(
        () => false,
      );
      if (hasPendingReview) {
        throw new Error(PENDING_REVIEW_COMMENT_ERROR);
      }
    }
    throw error;
  });
  const comment = normalizeGitHubReviewComment(JSON.parse(rawComment));
  if (!comment) {
    throw new Error('GitHub accepted the comment but did not return line metadata.');
  }
  return comment;
};

/** @param {RepositoryHost} host @param {string} launchPath @param {SubmitPullRequestReviewRequest} request */
const submitPullRequestReview = async (host, launchPath, request) => {
  const repoRoot = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const pullRequest = parseGitHubPullRequestUrl(request.source.url);
  const metadata = await readPullRequestMetadata(repoRoot, pullRequest);
  await selectPullRequestRemote(host, repoRoot, pullRequest, metadata.head?.sha);

  await ghApi(
    repoRoot,
    [
      '-X',
      'POST',
      `repos/${pullRequest.owner}/${pullRequest.repo}/pulls/${pullRequest.number}/reviews`,
      '--input',
      '-',
    ],
    createPullRequestReviewPayload(request),
  );
};

/** @param {SubmitPullRequestReviewRequest} request */
const createPullRequestReviewPayload = (request) => {
  const body = request.body?.trim() || '';
  if (request.event === 'COMMENT' && request.comments.length === 0 && !body) {
    throw new Error('A comment review requires an inline comment or a review comment.');
  }

  return {
    body:
      body ||
      (request.event === 'REQUEST_CHANGES' && request.comments.length === 0
        ? 'Requesting changes.'
        : ''),
    comments: request.comments.map(normalizePullRequestComment),
    event: request.event,
  };
};

module.exports = {
  GH_NOT_FOUND_CODE,
  PENDING_REVIEW_COMMENT_ERROR,
  collectResolvedReviewCommentIds,
  createPatchFromPullRequestFile,
  createPullRequestSection,
  createGitHubSection,
  createPullRequestSource,
  getGhCommand,
  getPullRequestHeadImageSource,
  ghApi,
  listPullRequestHistory,
  normalizeGitHubCommit,
  normalizeGitHubPullRequestCommit,
  normalizeGitHubReviewComment,
  normalizePullRequestComment,
  normalizePullRequestFileStatus,
  parseGitHubPullRequestUrl,
  readPullRequestImageContent,
  readPullRequestSectionContent,
  readGitHubImageFile,
  readGitHubTextFile,
  readPullRequestState,
  selectPullRequestRemote,
  selectUnresolvedReviewComments,
  splitPullRequestDiff,
  submitPullRequestComment,
  submitPullRequestReview,
};
