// @ts-check

const { parseReviewUrl } = require('../review-source.cjs');

/** @typedef {import('../host/repository-host.cjs').RepositoryHost} RepositoryHost */

/** @param {import('../../core/types.ts').ReviewSource} source */
const isGitHubSource = (source) =>
  (source.type === 'commit' && Boolean(source.github)) ||
  (source.type === 'pull-request' && parseReviewUrl(source.url)?.provider === 'github');

/**
 * Definition search may inspect objects already present locally, but must never
 * download a PR's missing commits, trees or blobs while doing so.
 * @param {RepositoryHost} host
 * @returns {RepositoryHost}
 */
const withNoLazyFetch = (host) => ({
  ...host,
  exec: (command, args, options) =>
    host.exec(command, args, {
      ...options,
      env: { ...options?.env, GIT_NO_LAZY_FETCH: '1' },
    }),
  spawn: (command, args, options) =>
    host.spawn(command, args, {
      ...options,
      env: { ...options?.env, GIT_NO_LAZY_FETCH: '1' },
    }),
});

/** @param {ReadonlyArray<string>} args */
const assertMetadataCommand = (args) => {
  const command = args.join('\0');
  if (
    command === 'rev-parse\0--show-toplevel' ||
    command === 'remote' ||
    command === 'symbolic-ref\0--short\0HEAD' ||
    (args.length === 3 &&
      args[0] === 'config' &&
      args[1] === '--get' &&
      /^remote\..+\.url$/.test(args[2])) ||
    (args.length === 4 &&
      args[0] === 'ls-remote' &&
      args[1] === '--refs' &&
      !args[2].startsWith('-') &&
      /^refs\/pull\/[1-9]\d*\/head$/.test(args[3]))
  ) {
    return;
  }
  throw new Error(
    `GitHub reviews only read Git repository metadata; refused git ${args[0] || '(missing command)'}.`,
  );
};

/**
 * PRs and their history commits use GitHub's API for all object data. Keep Git
 * limited to local metadata and ref advertisements (which download no objects),
 * and disable lazy fetching as an additional safeguard for partial clones.
 *
 * @param {RepositoryHost} host
 * @param {string} root
 * @param {ReadonlyArray<string>} args
 */
const git = async (host, root, args) => {
  assertMetadataCommand(args);
  return (
    await host.exec('git', ['-C', root, ...args], {
      env: { GIT_NO_LAZY_FETCH: '1' },
    })
  ).toString('utf8');
};

/** @param {RepositoryHost} host @param {string} root @param {ReadonlyArray<string>} args */
const gitOrEmpty = async (host, root, args) => {
  assertMetadataCommand(args);
  try {
    return await git(host, root, args);
  } catch {
    return '';
  }
};

module.exports = { git, gitOrEmpty, isGitHubSource, withNoLazyFetch };
