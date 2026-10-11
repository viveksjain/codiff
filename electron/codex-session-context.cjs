// @ts-check

const { cleanText, truncate } = require('./codex.cjs');
const { readSessionFileTail, getSessionHome, hostPath } = require('./session-context-shared.cjs');

const MAX_SESSION_SCAN_FILES = 20_000;
const MAX_SESSION_MESSAGE_CHARS = 2_400;
const MAX_SESSION_MESSAGES = 18;
const MAX_SESSION_CONTEXT_CHARS = 28_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @typedef {import('./host/repository-host.cjs').RepositoryHost} RepositoryHost
 * @typedef {import('../core/types.ts').WalkthroughContext} WalkthroughContext
 */

/** @param {unknown} value */
const normalizeCodexSessionId = (value) =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : '';

/** @param {unknown} value */
const extractContentText = (value) => {
  if (!Array.isArray(value)) {
    return '';
  }

  return cleanText(
    value
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }

        if (
          'text' in item &&
          typeof item.text === 'string' &&
          (!('type' in item) ||
            item.type === 'input_text' ||
            item.type === 'output_text' ||
            item.type === 'text')
        ) {
          return item.text;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n'),
  );
};

/** @param {string} text */
const isNoiseMessage = (text) => {
  const normalized = cleanText(text).toLowerCase();
  return (
    normalized === '$codiff' || normalized === 'show me codiff' || normalized === 'open codiff'
  );
};

/** @param {string} path @param {string} sessionId */
const pathMatchesSessionId = (path, sessionId) =>
  path.endsWith('.jsonl') && path.toLowerCase().includes(sessionId.toLowerCase());

/**
 * @param {RepositoryHost} host
 * @param {string} root
 * @param {string} sessionId
 */
const findCodexSessionFile = async (host, root, sessionId) => {
  if (!sessionId) {
    return null;
  }

  /** @type {Array<string>} */
  const stack = [root];
  let scanned = 0;

  while (stack.length > 0 && scanned < MAX_SESSION_SCAN_FILES) {
    const directory = stack.pop();
    if (!directory) {
      continue;
    }

    /** @type {Awaited<ReturnType<RepositoryHost['readdir']>>} */
    let entries;
    try {
      entries = (await host.readdir(directory)).sort((a, b) => b.name.localeCompare(a.name));
    } catch (error) {
      if (error instanceof Error && error.name.startsWith('Host')) throw error;
      continue;
    }

    const directories = [];
    for (const entry of entries) {
      scanned += 1;
      const path = hostPath(host).join(directory, entry.name);
      if (entry.type === 'file' && pathMatchesSessionId(path, sessionId)) {
        return path;
      }

      if (entry.type === 'directory') {
        directories.push(path);
      }

      if (scanned >= MAX_SESSION_SCAN_FILES) {
        break;
      }
    }

    stack.push(...directories.reverse());
  }

  return null;
};

/** @param {unknown} input */
const extractMessage = (input) => {
  if (!input || typeof input !== 'object') {
    return null;
  }

  if (!('type' in input) || input.type !== 'response_item') {
    return null;
  }

  const payload = 'payload' in input ? input.payload : null;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (!('type' in payload) || payload.type !== 'message') {
    return null;
  }

  const role = 'role' in payload ? payload.role : undefined;
  if (role !== 'assistant' && role !== 'user') {
    return null;
  }

  const text = truncate(
    extractContentText('content' in payload ? payload.content : null),
    MAX_SESSION_MESSAGE_CHARS,
  );
  if (!text || isNoiseMessage(text)) {
    return null;
  }

  return { role, text };
};

/** @param {RepositoryHost} host @param {string} sessionPath */
const readSessionMessages = async (host, sessionPath) => {
  /** @type {Array<{role: 'assistant' | 'user'; text: string}>} */
  const messages = [];
  let totalChars = 0;

  for (const line of (await readSessionFileTail(host, sessionPath)).split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      const message = extractMessage(JSON.parse(line));
      if (!message) {
        continue;
      }

      messages.push(message);
    } catch {
      // Ignore malformed or future-format records in Codex session logs.
    }
  }

  /** @type {Array<{role: 'assistant' | 'user'; text: string}>} */
  const selected = [];
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

/**
 * @param {RepositoryHost} host
 * @param {string | undefined} codexSessionId
 * @returns {Promise<WalkthroughContext | null>}
 */
const readCodexSessionContext = async (host, codexSessionId) => {
  const threadId = normalizeCodexSessionId(codexSessionId);
  if (!threadId) {
    return null;
  }

  const path = await findCodexSessionFile(
    host,
    hostPath(host).join(await getSessionHome(host, 'CODEX_HOME', '.codex'), 'sessions'),
    threadId,
  );
  const messages = path ? await readSessionMessages(host, path) : [];

  return {
    messages,
    risks:
      messages.length === 0
        ? ['Codiff could not find recent readable messages for the linked Codex session.']
        : undefined,
    source: {
      generatedAt: new Date().toISOString(),
      threadId,
      type: 'codex-session-excerpt',
    },
    version: 1,
  };
};

module.exports = { readCodexSessionContext };
