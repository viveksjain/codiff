// @ts-check

const { spawn } = require('node:child_process');

/**
 * @typedef {{
 *   command?: string;
 *   spawn?: typeof spawn;
 * }} AgentCommandTransport
 */

/**
 * @param {AgentCommandTransport | undefined} transport
 * @param {() => string} getCommand
 */
const resolveAgentCommandTransport = (transport, getCommand) => ({
  command: transport?.command || getCommand(),
  spawn: transport?.spawn || spawn,
});

/**
 * Run a user-configured Bash command, passing generated CLI arguments literally.
 * The host resolves Bash so wrappers work on both local and SSH repositories.
 * @param {import('./host/repository-host.cjs').RepositoryHost} host
 * @param {string} command
 * @param {string} [cwd]
 * @returns {Promise<AgentCommandTransport>}
 */
const createBashCommandTransport = async (host, command, cwd) => {
  const bash = await host.resolveCommand('bash');
  if (!bash) {
    throw new Error(
      `Bash is required to run configured agent commands${host.label ? ` on ${host.label}` : ''}.`,
    );
  }
  const spawnCommand = (
    /** @type {string} */ _command,
    /** @type {ReadonlyArray<string>} */ args,
    /** @type {import('node:child_process').SpawnOptions} */ options = {},
  ) =>
    host.spawn(bash, ['-c', `${command} "$@"`, 'codiff-agent', ...args], {
      cwd: options.cwd ? String(options.cwd) : cwd,
      env: /** @type {Record<string, string>} */ (options.env),
    });
  return {
    command: bash,
    spawn: /** @type {typeof spawn} */ (/** @type {unknown} */ (spawnCommand)),
  };
};

/**
 * Remote agents are killed outright: SIGTERM to a remote wrapper can leave its
 * workers running on the host.
 *
 * @param {import('./host/repository-host.cjs').RepositoryHost | undefined} host
 * @returns {NodeJS.Signals}
 */
const getAgentKillSignal = (host) => (host && host.id !== 'local' ? 'SIGKILL' : 'SIGTERM');

module.exports = { createBashCommandTransport, getAgentKillSignal, resolveAgentCommandTransport };
