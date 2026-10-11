// @ts-check
/** Preserves legacy local keys and separates identical paths on remote hosts.
 * @param {string | undefined} hostId @param {string} repositoryPath */
const getRepositoryKey = (hostId, repositoryPath) =>
  !hostId || hostId === 'local' ? repositoryPath : `${hostId}\0${repositoryPath}`;
module.exports = { getRepositoryKey };
