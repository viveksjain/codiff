// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { basename, dirname, isAbsolute, relative, resolve, sep } = require('node:path');

/**
 * @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** @param {string} content */
const hashContent = (content) => createHash('sha256').update(content).digest('hex');

/** @param {string} root @param {string} path */
const isWithinRoot = (root, path) => {
  const part = relative(root, path);
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** @param {RepositoryHost} host @param {string} repositoryRoot @param {string} path */
const resolveRepositoryFile = async (host, repositoryRoot, path) => {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid repository file path.');
  }
  const root = await host.realpath(repositoryRoot);
  const requestedPath = resolve(root, path);
  const absolutePath = await host.realpath(requestedPath);
  if (!isWithinRoot(root, requestedPath) || !isWithinRoot(root, absolutePath)) {
    throw new Error('File path escapes the repository.');
  }
  // Git metadata must never be editable through the code surface.
  if (
    relative(root, requestedPath).split(sep).includes('.git') ||
    relative(root, absolutePath).split(sep).includes('.git')
  ) {
    throw new Error('Git metadata cannot be edited.');
  }
  return { absolutePath, path, root };
};

/** @param {RepositoryHost} host @param {{absolutePath: string; path: string; root: string}} resolved */
const readResolvedFile = async (host, resolved) => {
  const fileStat = await host.stat(resolved.absolutePath);
  if (fileStat.type !== 'file') {
    throw new Error('Only regular files can be edited.');
  }
  if (fileStat.size > MAX_FILE_BYTES) {
    throw new Error('File exceeds the 2 MB editing limit.');
  }
  const bytes = await host.readFile(resolved.absolutePath);
  const content = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
    throw new Error('Only UTF-8 text files can be edited.');
  }
  return { content, path: resolved.path, root: resolved.root, version: hashContent(content) };
};

/** @param {RepositoryHost} host @param {string} repositoryRoot @param {string} path */
const readRepositoryFile = async (host, repositoryRoot, path) =>
  readResolvedFile(host, await resolveRepositoryFile(host, repositoryRoot, path));

/**
 * @param {RepositoryHost} host
 * @param {string} repositoryRoot
 * @param {import('../core/types.ts').SaveRepositoryFileRequest} request
 * @returns {Promise<import('../core/types.ts').SaveRepositoryFileResult>}
 */
const writeRepositoryFile = async (host, repositoryRoot, request) => {
  if (
    typeof request.content !== 'string' ||
    request.content.includes('\0') ||
    Buffer.byteLength(request.content, 'utf8') > MAX_FILE_BYTES
  ) {
    throw new Error('File must be UTF-8 text within the 2 MB editing limit.');
  }
  const resolved = await resolveRepositoryFile(host, repositoryRoot, request.path);
  if (request.root !== resolved.root) {
    throw new Error('The edited file belongs to a different repository.');
  }
  const current = await readResolvedFile(host, resolved);
  if (current.content === request.content) {
    return { document: current, status: 'saved' };
  }
  if (current.version !== request.baseVersion) {
    return { document: current, status: 'conflict' };
  }
  const temporaryPath = resolve(
    dirname(resolved.absolutePath),
    `.${basename(resolved.absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const mode = (await host.stat(resolved.absolutePath)).mode & 0o7777;
  try {
    await host.writeFile(temporaryPath, request.content, { exclusive: true, mode });
    // Check again after preparing the replacement, including symlink retargets.
    const latestResolved = await resolveRepositoryFile(host, repositoryRoot, request.path);
    const latest = await readResolvedFile(host, latestResolved);
    if (
      latestResolved.absolutePath !== resolved.absolutePath ||
      latest.version !== current.version
    ) {
      await host.rm(temporaryPath, { force: true });
      return { document: latest, status: 'conflict' };
    }
    await host.rename(temporaryPath, resolved.absolutePath);
  } catch (error) {
    await host.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return { document: await readResolvedFile(host, resolved), status: 'saved' };
};

module.exports = { readRepositoryFile, resolveRepositoryFile, writeRepositoryFile };
