// @ts-check
// Preserve a real stdout file descriptor for CLIs that truncate piped exports.
const { spawn } = require('node:child_process');
const { closeSync, mkdtempSync, openSync, rmSync } = require('node:fs');
const { readFile, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
/** @param {string} command @param {Array<string>} args @param {number} timeoutMs @param {number} maxBytes */
const exportLocalCommandOutput = (command, args, timeoutMs, maxBytes) =>
  new Promise((resolve) => {
    const directory = mkdtempSync(join(tmpdir(), 'codiff-opencode-session-'));
    const path = join(directory, 'session.json');
    /** @type {number | undefined} */
    let output;
    let settled = false;
    let timedOut = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeout;

    const closeOutput = () => {
      if (output == null) {
        return;
      }

      try {
        closeSync(output);
      } catch {}
      output = undefined;
    };

    const removeDirectory = () => {
      try {
        rmSync(directory, { force: true, recursive: true });
      } catch {}
    };

    /** @param {unknown} value */
    const finish = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      closeOutput();
      removeDirectory();
      resolve(value);
    };

    try {
      output = openSync(path, 'w', 0o600);
      // OpenCode can truncate large exports when stdout is a pipe. Writing
      // directly to a file descriptor preserves the complete JSON document.
      const child = spawn(command, args, {
        stdio: ['ignore', output, 'ignore'],
        windowsHide: true,
      });
      timeout = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        finish(null);
      }, timeoutMs);
      child.once('error', () => finish(null));
      child.once('close', async (code) => {
        if (settled) {
          closeOutput();
          removeDirectory();
          return;
        }

        if (timedOut || code !== 0) {
          finish(null);
          return;
        }

        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        closeOutput();

        try {
          if ((await stat(path)).size > maxBytes) {
            finish(null);
            return;
          }

          const input = JSON.parse(await readFile(path, 'utf8'));
          finish(input);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });

module.exports = { exportLocalCommandOutput };
