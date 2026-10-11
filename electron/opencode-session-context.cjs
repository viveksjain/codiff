// @ts-check

const { cleanText, truncate } = require('./agent-shared.cjs');
const { exportLocalCommandOutput } = require('./host/local-command-output.cjs');
const { hostPath } = require('./session-context-shared.cjs');
const { getOpenCodeCommand } = require('./opencode.cjs');

const OPENCODE_EXPORT_TIMEOUT_MS = 15_000;
const MAX_OPENCODE_EXPORT_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_MESSAGE_CHARS = 2_400;
const MAX_SESSION_MESSAGES = 18;
const MAX_SESSION_CONTEXT_CHARS = 28_000;
const SESSION_ID_PATTERN = /^ses_[a-z0-9]{8,}$/i;

/**
 * @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../core/types.ts').WalkthroughContext} WalkthroughContext
 */

/** @param {unknown} value */
const normalizeOpenCodeSessionId = (value) =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : '';

/** @param {string} text */
const isNoiseMessage = (text) => {
  const normalized = cleanText(text).toLowerCase();
  return (
    normalized === '/codiff' ||
    normalized === '$codiff' ||
    normalized === 'codiff' ||
    normalized === 'show me codiff' ||
    normalized === 'open codiff'
  );
};

/** @param {unknown} value */
const extractMessage = (value) => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const info = 'info' in value ? value.info : null;
  if (!info || typeof info !== 'object') {
    return null;
  }

  const role = 'role' in info ? info.role : undefined;
  if (role !== 'assistant' && role !== 'user') {
    return null;
  }

  const parts = 'parts' in value && Array.isArray(value.parts) ? value.parts : [];
  const text = truncate(
    cleanText(
      parts
        .map((part) =>
          part &&
          typeof part === 'object' &&
          'type' in part &&
          part.type === 'text' &&
          'text' in part &&
          typeof part.text === 'string'
            ? part.text
            : '',
        )
        .filter(Boolean)
        .join('\n'),
    ),
    MAX_SESSION_MESSAGE_CHARS,
  );
  if (!text || isNoiseMessage(text)) {
    return null;
  }

  return { role, text };
};

/** @param {unknown} input */
const extractSessionMessages = (input) => {
  if (
    !input ||
    typeof input !== 'object' ||
    !('messages' in input) ||
    !Array.isArray(input.messages)
  ) {
    return [];
  }

  const messages = input.messages.map(extractMessage).filter(Boolean);
  /** @type {Array<{role: 'assistant' | 'user'; text: string}>} */
  const selected = [];
  let totalChars = 0;

  for (const message of messages.slice().reverse()) {
    if (selected.length >= MAX_SESSION_MESSAGES) {
      break;
    }

    const cost = message.role.length + message.text.length + 2;
    if (selected.length > 0 && totalChars + cost > MAX_SESSION_CONTEXT_CHARS) {
      break;
    }

    selected.push(message);
    totalChars += cost;
  }

  return selected.reverse();
};

/** @param {unknown} input @param {string} sessionId */
const isMatchingSessionExport = (input, sessionId) =>
  Boolean(
    input &&
    typeof input === 'object' &&
    'info' in input &&
    input.info &&
    typeof input.info === 'object' &&
    'id' in input.info &&
    input.info.id === sessionId,
  );

/** @param {RepositoryHost} host @param {string} sessionId */
const exportOpenCodeSession = async (host, sessionId) => {
  const environment = await host.getEnvironment();
  const command =
    host.id === 'local'
      ? getOpenCodeCommand()
      : await host.resolveCommand(environment.CODIFF_OPENCODE_PATH || 'opencode');
  if (!command) return null;
  if (host.id === 'local') {
    const input = await exportLocalCommandOutput(
      command,
      ['export', '--pure', sessionId],
      OPENCODE_EXPORT_TIMEOUT_MS,
      MAX_OPENCODE_EXPORT_BYTES,
    );
    return isMatchingSessionExport(input, sessionId) ? input : null;
  }
  const directory = await host.mkdtemp('codiff-opencode-session-');
  try {
    const path = hostPath(host).join(directory, 'session.json');
    await new Promise((resolve, reject) => {
      const child = host.spawn(
        '/bin/sh',
        ['-c', 'exec "$1" export --pure "$2" > "$3"', 'sh', command, sessionId, path],
        { env: environment },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), OPENCODE_EXPORT_TIMEOUT_MS);
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end();
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve(undefined) : reject(new Error('OpenCode export failed.'));
      });
    });
    if ((await host.stat(path)).size > MAX_OPENCODE_EXPORT_BYTES) return null;
    const input = JSON.parse((await host.readFile(path)).toString('utf8'));
    return isMatchingSessionExport(input, sessionId) ? input : null;
  } finally {
    await host.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * @param {RepositoryHost} host
 * @param {string | undefined} opencodeSessionId
 * @returns {Promise<WalkthroughContext | null>}
 */
const readOpenCodeSessionContext = async (host, opencodeSessionId) => {
  const threadId = normalizeOpenCodeSessionId(opencodeSessionId);
  if (!threadId) {
    return null;
  }

  let session;
  try {
    session = await exportOpenCodeSession(host, threadId);
  } catch (error) {
    if (error instanceof Error && error.name.startsWith('Host')) throw error;
    session = null;
  }
  const messages = extractSessionMessages(session);
  return {
    messages,
    risks:
      messages.length === 0
        ? ['Codiff could not find recent readable messages for the linked OpenCode session.']
        : undefined,
    source: {
      generatedAt: new Date().toISOString(),
      threadId,
      type: 'opencode-session-excerpt',
    },
    version: 1,
  };
};

module.exports = { readOpenCodeSessionContext };
