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
 * Remote agents are killed outright: SIGTERM to a remote wrapper can leave its
 * workers running on the host.
 *
 * @param {import('./host/repository-host.cjs').RepositoryHost | undefined} host
 * @returns {NodeJS.Signals}
 */
const getAgentKillSignal = (host) => (host && host.id !== 'local' ? 'SIGKILL' : 'SIGTERM');

module.exports = { getAgentKillSignal, resolveAgentCommandTransport };
