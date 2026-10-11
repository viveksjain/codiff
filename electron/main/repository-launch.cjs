// @ts-check
const { resolve } = require('node:path');
const {
  parseRepositoryTarget,
  resolveRemoteRepository,
  resolveRemoteSource,
} = require('../host/repository-target.cjs');
/** @typedef {typeof import('../host/host-registry.cjs').createHostRegistry} RegistryFactory
 * @typedef {import('../host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../../core/types.ts').CodiffLaunchOptions} CodiffLaunchOptions */
/** @param {{registry: ReturnType<RegistryFactory>; localHost: RepositoryHost}} context
 * @param {string} path @param {CodiffLaunchOptions} launchOptions */
const resolveRepositoryLaunch = async ({ registry, localHost }, path, launchOptions) => {
  const target = parseRepositoryTarget(path);
  if (!target) {
    return {
      host: localHost,
      repositoryPath: resolve(path),
      launchOptions,
      release: async () => {},
      target: null,
    };
  }
  if (launchOptions.source?.type === 'pull-request') {
    throw new Error('PR/MR reviews are unavailable for remote repositories.');
  }
  if (launchOptions.planFile) {
    throw new Error('Plan reviews are unavailable for remote repositories.');
  }
  const lease = await registry.acquire(target);
  try {
    const repositoryPath = await resolveRemoteRepository(lease.host, target.path);
    const source = await resolveRemoteSource(lease.host, repositoryPath, {
      candidate: launchOptions.remoteSourceCandidate,
      range: launchOptions.source?.type === 'range' ? launchOptions.source : undefined,
    });
    return {
      ...lease,
      repositoryPath,
      target,
      launchOptions: {
        ...launchOptions,
        source: source ?? launchOptions.source,
        remoteSourceCandidate: undefined,
      },
    };
  } catch (error) {
    await lease.release();
    throw error;
  }
};
module.exports = { resolveRepositoryLaunch };
