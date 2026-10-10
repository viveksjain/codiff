// @ts-check

const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { readConfig } = require('./config.cjs');
const { readGitIdentity } = require('./git-state.cjs');
const { createSharedPlanSnapshot } = require('./shared-plan.cjs');
const { uploadSnapshot } = require('./headless-walkthrough-share.cjs');
const { resolvePlanShareTarget } = require('./walkthrough-sharing.cjs');

/** @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost */

/** @param {string} repositoryPath */
const hasGitMetadata = (repositoryPath) => {
  let current = resolve(repositoryPath);
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
};

/**
 * @param {RepositoryHost} host
 * @param {{
 *   agent?: 'claude' | 'codex' | 'opencode' | 'pi';
 *   codiffVersion: string;
 *   forcePublic?: boolean;
 *   openExternal: (url: string) => Promise<void>;
 *   planFile: string;
 *   repositoryPath: string;
 *   serviceUrlOverride?: string;
 *   sessionId?: string;
 * }} options
 */
const sharePlanFile = async (
  host,
  {
    agent,
    codiffVersion,
    forcePublic,
    openExternal,
    planFile,
    repositoryPath,
    serviceUrlOverride,
    sessionId,
  },
) => {
  const config = readConfig();
  const uploader = hasGitMetadata(repositoryPath)
    ? await readGitIdentity(host, repositoryPath)
    : {};
  const content = readFileSync(planFile, 'utf8');
  const review = {
    document: {
      id: `plan:${planFile}`,
      path: planFile,
      version: '',
    },
    threads: [],
    version: /** @type {const} */ (1),
  };

  return uploadSnapshot({
    codiffVersion,
    openExternal,
    serviceUrlOverride,
    snapshot: createSharedPlanSnapshot({
      agent,
      codiffVersion,
      content,
      filePath: planFile,
      review,
      sessionId,
      theme: config.settings.theme,
    }),
    target: resolvePlanShareTarget({
      email: uploader.email,
      forcePublic,
      overrideUrl: serviceUrlOverride,
    }),
    uploader,
  });
};

module.exports = {
  sharePlanFile,
};
