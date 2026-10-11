// @ts-check

class HostAuthRequiredError extends Error {
  /** @param {string} alias */
  constructor(alias) {
    super(`${alias} needs interactive login. Run \`codiff ${alias}:<path>\` from a terminal.`);
    this.name = 'HostAuthRequiredError';
    this.alias = alias;
  }
}

class HostUnreachableError extends Error {
  /** @param {string} alias @param {string} detail */
  constructor(alias, detail) {
    super(detail.trim() || `Could not reach ${alias}.`);
    this.name = 'HostUnreachableError';
    this.alias = alias;
  }
}

class HostDisconnectedError extends Error {
  /** @param {string} alias @param {string} [detail] */
  constructor(alias, detail = '') {
    super(`Lost connection to ${alias}.`);
    this.name = 'HostDisconnectedError';
    this.alias = alias;
    this.detail = detail.trim() || 'The SSH master connection is no longer available.';
  }
}

class UnsupportedRemoteShellError extends Error {
  /** @param {string} alias @param {string} shell */
  constructor(alias, shell) {
    super(`Codiff needs a POSIX or fish login shell on ${alias}.`);
    this.name = 'UnsupportedRemoteShellError';
    this.alias = alias;
    this.shell = shell;
  }
}

class RemoteCommandMissingError extends Error {
  /** @param {string} alias @param {string} command */
  constructor(alias, command) {
    super(`${command} isn't installed on ${alias}.`);
    this.name = 'RemoteCommandMissingError';
    this.alias = alias;
    this.command = command;
  }
}

class RemoteShellNoiseError extends Error {
  /** @param {string} alias */
  constructor(alias) {
    super(
      `${alias}'s shell startup files print output in non-interactive sessions, which breaks Codiff. Only print output in interactive shells.`,
    );
    this.name = 'RemoteShellNoiseError';
    this.alias = alias;
  }
}

const AUTH_PATTERNS = [
  /permission denied \(/i,
  /host key verification failed/i,
  /too many authentication failures/i,
  /no more authentication methods/i,
];

/**
 * While connecting, any non-authentication failure means the host could not be
 * reached; once connected, it means the connection was lost.
 *
 * @param {string} alias
 * @param {string} stderr
 * @param {{connected?: boolean}} [options]
 * @returns {Error}
 */
const classifySshFailure = (alias, stderr, { connected = true } = {}) =>
  AUTH_PATTERNS.some((pattern) => pattern.test(stderr))
    ? new HostAuthRequiredError(alias)
    : connected
      ? new HostDisconnectedError(alias, stderr)
      : new HostUnreachableError(alias, stderr);

module.exports = {
  HostAuthRequiredError,
  HostDisconnectedError,
  HostUnreachableError,
  RemoteCommandMissingError,
  RemoteShellNoiseError,
  UnsupportedRemoteShellError,
  classifySshFailure,
};
