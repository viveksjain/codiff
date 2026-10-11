// @ts-check
const ENVIRONMENT_MARKER = '__CODIFF_LOGIN_SHELL_ENVIRONMENT__';
const ENVIRONMENT_COMMAND = `printf '${ENVIRONMENT_MARKER}'; /usr/bin/env -0`;
/** @param {string} output @returns {Record<string, string>} */
const parseEnvironment = (output) => {
  const marker = output.indexOf(ENVIRONMENT_MARKER);
  if (marker < 0) {
    throw new Error('Login shell did not return its environment.');
  }
  /** @type {Record<string, string>} */
  const environment = {};
  for (const entry of output.slice(marker + ENVIRONMENT_MARKER.length).split('\0')) {
    const separator = entry.indexOf('=');
    if (separator > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, separator))) {
      environment[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return environment;
};
module.exports = { ENVIRONMENT_COMMAND, parseEnvironment };
