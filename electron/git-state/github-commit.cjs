// @ts-check

const { getFingerprint, git, validateRepositoryPath } = require('./common.cjs');
const { createEmptyFileContent } = require('./git-files.cjs');
const {
  createGitHubSection,
  createPatchFromPullRequestFile,
  ghApi,
  normalizePullRequestFileStatus,
  readGitHubImageFile,
  readGitHubTextFile,
  splitPullRequestDiff,
} = require('./pull-request.cjs');

/**
 * @typedef {import('../host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../../core/types.ts').DiffSectionContentRequest} DiffSectionContentRequest
 * @typedef {import('../../core/types.ts').CommitMetadata} CommitMetadata
 * @typedef {import('../../core/types.ts').RepositoryState} RepositoryState
 * @typedef {Extract<import('../../core/types.ts').ReviewSource, {type: 'commit'}>} CommitSource
 * @typedef {{owner: string; parentRef?: string | null; repo: string}} GitHubRepository
 * @typedef {{date?: string; email?: string; name?: string}} GitHubPerson
 * @typedef {{additions?: number; deletions?: number; filename: string; patch?: string; previous_filename?: string; status: string}} GitHubFile
 * @typedef {{commit?: {author?: GitHubPerson; committer?: GitHubPerson; message?: string; verification?: {verified?: boolean}}; files: Array<GitHubFile>; parents?: Array<{sha: string}>; sha: string}} GitHubCommit
 */

/** @param {CommitSource} source @returns {GitHubRepository} */
const getRepository = (source) => {
  if (!source.github) {
    throw new Error('GitHub commit source is missing its repository.');
  }
  return source.github;
};

/** @param {string} root @param {CommitSource} source */
const readCommit = async (root, source) => {
  const repository = getRepository(source);
  /** @type {Array<GitHubCommit>} */
  const pages = JSON.parse(
    await ghApi(root, [
      '--paginate',
      '--slurp',
      `repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(source.ref)}?per_page=100`,
    ]),
  );
  return { ...pages[0], files: pages.flatMap((page) => page.files || []) };
};

/** @param {GitHubCommit} commit @param {RepositoryState['files']} files @returns {CommitMetadata} */
const createMetadata = (commit, files) => {
  const message = commit.commit?.message || '';
  /** @param {GitHubPerson | undefined} details */
  const person = (details) => ({
    date: details?.date || '',
    email: details?.email || '',
    name: details?.name || '',
  });
  const metadataFiles = files.map((file) => {
    const details = commit.files.find((candidate) => candidate.filename === file.path);
    return {
      additions: details?.additions,
      binary: file.sections[0].binary,
      deletions: details?.deletions,
      oldPath: file.oldPath,
      path: file.path,
      status: file.status,
    };
  });
  return {
    author: person(commit.commit?.author),
    body: message.split('\n').slice(1).join('\n').trim(),
    committer: person(commit.commit?.committer),
    files: metadataFiles,
    parents: (commit.parents || []).map((parent) => parent.sha),
    ref: commit.sha,
    refs: [],
    shortRef: commit.sha.slice(0, 7),
    signature: { status: commit.commit?.verification?.verified ? 'G' : 'N' },
    stats: {
      additions: metadataFiles.reduce((total, file) => total + (file.additions || 0), 0),
      binaryFiles: metadataFiles.filter((file) => file.binary).length,
      deletions: metadataFiles.reduce((total, file) => total + (file.deletions || 0), 0),
      files: files.length,
      renamedFiles: files.filter((file) => file.status === 'renamed').length,
    },
    subject: message.split('\n')[0],
    trailers: [],
  };
};

/** @param {RepositoryHost} host @param {string} launchPath @param {CommitSource} source @returns {Promise<RepositoryState>} */
const readGitHubCommitState = async (host, launchPath, source) => {
  const root = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const repository = getRepository(source);
  const [commit, diff] = await Promise.all([
    readCommit(root, source),
    ghApi(root, [
      '-H',
      'Accept: application/vnd.github.v3.diff',
      `repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(source.ref)}`,
    ]),
  ]);
  const patches = splitPullRequestDiff(diff);
  /** @type {RepositoryState['files']} */
  const files = commit.files
    .map((file) => {
      const patch = patches.get(file.filename) || createPatchFromPullRequestFile(file);
      return {
        fingerprint: getFingerprint(
          `${repository.owner}/${repository.repo}:${commit.sha}:${file.filename}:${patch}`,
        ),
        oldPath: file.previous_filename,
        path: file.filename,
        sections: [createGitHubSection(`${file.filename}:${commit.sha}`, 'commit', file, patch)],
        status: normalizePullRequestFileStatus(file.status),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    branch: null,
    commitMetadata: createMetadata(commit, files),
    files,
    generatedAt: Date.now(),
    launchPath,
    root,
    source: {
      github: { ...repository, parentRef: commit.parents?.[0]?.sha ?? null },
      ref: commit.sha,
      type: 'commit',
    },
  };
};

/** @param {RepositoryHost} host @param {string} launchPath @param {CommitSource} source @param {string} requestedPath @param {DiffSectionContentRequest['file']} [snapshotFile] */
const readGitHubCommitSectionContent = async (
  host,
  launchPath,
  source,
  requestedPath,
  snapshotFile,
) => {
  const root = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
  const path = validateRepositoryPath(requestedPath);
  const repository = getRepository(source);
  const commit =
    !snapshotFile || repository.parentRef === undefined ? await readCommit(root, source) : null;
  const file = snapshotFile
    ? {
        filename: path,
        previous_filename: snapshotFile.oldPath,
        status: snapshotFile.status === 'deleted' ? 'removed' : snapshotFile.status,
      }
    : commit?.files.find((file) => file.filename === path);
  if (!file) throw new Error('File is not part of this commit.');
  const parent = repository.parentRef ?? commit?.parents?.[0]?.sha;
  const oldPath = file.previous_filename || path;
  const [oldFile, newFile] = await Promise.all([
    !parent || file.status === 'added'
      ? createEmptyFileContent(oldPath, parent, true)
      : readGitHubTextFile(root, repository, parent, oldPath),
    file.status === 'removed'
      ? createEmptyFileContent(path, source.ref, true)
      : readGitHubTextFile(root, repository, source.ref, path),
  ]);
  return createGitHubSection(
    `${path}:${source.ref}`,
    'commit',
    file,
    snapshotFile?.patch ?? createPatchFromPullRequestFile(file),
    oldFile,
    newFile,
  );
};

/** @param {RepositoryHost} host @param {string} launchPath @param {CommitSource} source @param {string} requestedPath @returns {Promise<import('../../core/types.ts').DiffImageContentResult>} */
const readGitHubCommitImageContent = async (host, launchPath, source, requestedPath) => {
  try {
    const root = (await git(host, launchPath, ['rev-parse', '--show-toplevel'])).trim();
    const path = validateRepositoryPath(requestedPath);
    const repository = getRepository(source);
    const commit = await readCommit(root, source);
    const file = commit.files.find((file) => file.filename === path);
    if (!file) throw new Error('File is not part of this commit.');
    const parent = commit.parents?.[0]?.sha;
    const [oldImage, newImage] = await Promise.all([
      parent && file.status !== 'added'
        ? readGitHubImageFile(root, repository, parent, file.previous_filename || path)
        : undefined,
      file.status !== 'removed'
        ? readGitHubImageFile(root, repository, source.ref, path)
        : undefined,
    ]);
    return oldImage || newImage
      ? { oldImage, newImage, status: 'ready' }
      : { reason: 'Codiff could not load either side of this image.', status: 'unavailable' };
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : 'Codiff could not load this image.',
      status: 'unavailable',
    };
  }
};

module.exports = {
  readGitHubCommitImageContent,
  readGitHubCommitSectionContent,
  readGitHubCommitState,
};
