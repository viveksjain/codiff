// @ts-check

/**
 * Remote commands reach the remote login shell as one string. Codiff sends a
 * fixed wrapper, `exec /bin/sh -c <script>`, quoted for that shell's dialect,
 * and the script itself is POSIX `sh` with every argument single-quoted.
 *
 * @typedef {'fish' | 'posix'} ShellDialect
 */

const PID_MARKER = '__codiff_pid__:';
const POSIX_SHELLS = new Set(['ash', 'bash', 'dash', 'ksh', 'mksh', 'sh', 'zsh']);
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @param {string} value */
const assertNoNul = (value) => {
  if (value.includes('\0')) {
    throw new Error('Shell arguments cannot contain NUL bytes.');
  }
};

/** @param {string} value */
const quotePosix = (value) => {
  assertNoNul(value);
  return `'${value.replaceAll("'", "'\\''")}'`;
};

/**
 * fish treats `\\` and `\'` as escapes inside single quotes.
 *
 * @param {string} value
 */
const quoteFish = (value) => {
  assertNoNul(value);
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
};

/** @param {string} shellPath @returns {ShellDialect | null} */
const getShellDialect = (shellPath) => {
  const name = shellPath.trim().split('/').pop() ?? '';
  return name === 'fish' ? 'fish' : POSIX_SHELLS.has(name) ? 'posix' : null;
};

/**
 * Builds a POSIX `sh` script that runs one command with exactly the given
 * argv. With `announcePid`, the script first prints `PID_MARKER<pid>` on
 * stderr; the command then replaces the shell, so it keeps that PID.
 *
 * @param {{
 *   announcePid?: boolean;
 *   args?: ReadonlyArray<string>;
 *   command: string;
 *   cwd?: string;
 *   env?: Readonly<Record<string, string>>;
 * }} options
 */
const buildCommandScript = ({ announcePid = false, args = [], command, cwd, env = {} }) => {
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
    return quotePosix(`${name}=${value}`);
  });
  const invocation = [
    'exec',
    ...(assignments.length > 0 ? ['env', ...assignments] : []),
    ...[command, ...args].map(quotePosix),
  ].join(' ');
  return [
    ...(cwd ? [`cd ${quotePosix(cwd)}`] : []),
    ...(announcePid ? [`printf '${PID_MARKER}%s\\n' "$$" >&2`] : []),
    invocation,
  ].join(' && ');
};

/** @param {string} script @param {ShellDialect} dialect */
const wrapForLoginShell = (script, dialect) =>
  `exec /bin/sh -c ${dialect === 'fish' ? quoteFish(script) : quotePosix(script)}`;

module.exports = {
  PID_MARKER,
  buildCommandScript,
  getShellDialect,
  quoteFish,
  quotePosix,
  wrapForLoginShell,
};
