// @ts-check

const codex = require('./codex.cjs');
const claude = require('./claude.cjs');
const opencode = require('./opencode.cjs');
const pi = require('./pi.cjs');
const { createBashCommandTransport } = require('./agent-command.cjs');
const { readCodexSessionContext } = require('./codex-session-context.cjs');
const { readClaudeSessionContext } = require('./claude-session-context.cjs');
const { readOpenCodeSessionContext } = require('./opencode-session-context.cjs');
const { readPiSessionContext } = require('./pi-session-context.cjs');

/**
 * @typedef {import('../core/types.ts').WalkthroughContext} WalkthroughContext
 * @typedef {{
 *   repositoryHost?: import('./host/repository-host.cjs').RepositoryHost;
 *   commandTransport?: import('./agent-command.cjs').AgentCommandTransport;
 *   fallbackModel?: string;
 *   model?: string;
 *   onMetrics?: (metrics: {
 *     transport: 'app-server' | 'exec';
 *     usage?: {
 *       cachedInputTokens: number;
 *       inputTokens: number;
 *       outputTokens: number;
 *       reasoningOutputTokens: number;
 *       totalTokens: number;
 *     };
 *   }) => void;
 *   onModelFallback?: (fallbackModel: string, originalModel: string) => Promise<void> | void;
 *   onPartialText?: (delta: string) => void;
 *   onProgress?: (phase: import('../core/types.ts').WalkthroughProgressPhase) => void;
 *   reasoningEffort?: string;
 *   timeoutMs?: number;
 * }} AgentOptions
 * @typedef {{
 *   id: 'codex' | 'claude' | 'opencode' | 'pi';
 *   label: string;
 *   cliName: string;
 *   cliPathEnvVar: string;
 *   defaultTimeoutMs: number;
 *   models: ReadonlyArray<{id: string; label: string}>;
 *   defaultModel: string;
 *   fallbackModel: string;
 *   modelSettingKey: 'openAIModel' | 'claudeModel' | 'opencodeModel' | 'piModel';
 *   normalizeModel: (value: unknown) => string;
 *   notFoundCode: string;
 *   isAvailable: () => boolean | Promise<boolean>;
 *   isNotFoundError: (error: unknown) => boolean;
 *   run: (
 *     repoRoot: string,
 *     prompt: string,
 *     schema: unknown,
 *     outputName?: string,
 *     timeoutMessage?: string,
 *     options?: AgentOptions,
 *   ) => Promise<string>;
 *   readSessionContext: (sessionId: string | undefined) => Promise<WalkthroughContext | null> | WalkthroughContext | null;
 *   sessionLaunchOptionKey: 'codexSessionId' | 'claudeSessionId' | 'opencodeSessionId' | 'piSessionId';
 * }} Agent
 */

const DEFAULT_AGENT_BACKEND = 'codex';
/** @type {ReadonlyArray<'codex' | 'claude' | 'opencode' | 'pi'>} */
const AGENT_BACKENDS = Object.freeze(['codex', 'claude', 'opencode', 'pi']);

/**
 * @param {() => string} getCommand
 * @param {(error: unknown) => boolean} isNotFoundError
 */
const canResolveCommand = (getCommand, isNotFoundError) => {
  try {
    getCommand();
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
};

/** @returns {Agent} */
const createCodexAgent = () => ({
  id: 'codex',
  label: 'Codex',
  cliName: 'codex',
  cliPathEnvVar: 'CODIFF_CODEX_PATH',
  defaultTimeoutMs: codex.CODEX_TIMEOUT_MS,
  models: codex.OPENAI_MODELS,
  defaultModel: codex.DEFAULT_OPENAI_MODEL,
  fallbackModel: codex.FALLBACK_OPENAI_MODEL,
  modelSettingKey: 'openAIModel',
  normalizeModel: codex.normalizeOpenAIModel,
  notFoundCode: codex.CODEX_NOT_FOUND_CODE,
  isAvailable: () => canResolveCommand(codex.getCodexCommand, codex.isCodexNotFoundError),
  isNotFoundError: codex.isCodexNotFoundError,
  run: codex.runCodex,
  readSessionContext: async () => {
    throw new Error('A repository host is required for session context.');
  },
  sessionLaunchOptionKey: 'codexSessionId',
});

/** @returns {Agent} */
const createClaudeAgent = () => ({
  id: 'claude',
  label: 'Claude Code',
  cliName: 'claude',
  cliPathEnvVar: 'CODIFF_CLAUDE_PATH',
  defaultTimeoutMs: claude.CLAUDE_TIMEOUT_MS,
  models: claude.CLAUDE_MODELS,
  defaultModel: claude.DEFAULT_CLAUDE_MODEL,
  fallbackModel: claude.FALLBACK_CLAUDE_MODEL,
  modelSettingKey: 'claudeModel',
  normalizeModel: claude.normalizeClaudeModel,
  notFoundCode: claude.CLAUDE_NOT_FOUND_CODE,
  isAvailable: () => canResolveCommand(claude.getClaudeCommand, claude.isClaudeNotFoundError),
  isNotFoundError: claude.isClaudeNotFoundError,
  run: claude.runClaude,
  readSessionContext: async () => {
    throw new Error('A repository host is required for session context.');
  },
  sessionLaunchOptionKey: 'claudeSessionId',
});

/** @returns {Agent} */
const createOpenCodeAgent = () => ({
  id: 'opencode',
  label: 'OpenCode',
  cliName: 'opencode',
  cliPathEnvVar: 'CODIFF_OPENCODE_PATH',
  defaultTimeoutMs: opencode.OPENCODE_TIMEOUT_MS,
  models: opencode.OPENCODE_MODELS,
  defaultModel: opencode.DEFAULT_OPENCODE_MODEL,
  fallbackModel: opencode.FALLBACK_OPENCODE_MODEL,
  modelSettingKey: 'opencodeModel',
  normalizeModel: opencode.normalizeOpenCodeModel,
  notFoundCode: opencode.OPENCODE_NOT_FOUND_CODE,
  isAvailable: () =>
    canResolveCommand(opencode.getOpenCodeCommand, opencode.isOpenCodeNotFoundError),
  isNotFoundError: opencode.isOpenCodeNotFoundError,
  run: opencode.runOpenCode,
  readSessionContext: async () => {
    throw new Error('A repository host is required for session context.');
  },
  sessionLaunchOptionKey: 'opencodeSessionId',
});

/** @returns {Agent} */
const createPiAgent = () => ({
  id: 'pi',
  label: 'Pi',
  cliName: 'pi',
  cliPathEnvVar: 'CODIFF_PI_PATH',
  defaultTimeoutMs: pi.PI_TIMEOUT_MS,
  models: pi.PI_MODELS,
  defaultModel: pi.DEFAULT_PI_MODEL,
  fallbackModel: pi.FALLBACK_PI_MODEL,
  modelSettingKey: 'piModel',
  normalizeModel: pi.normalizePiModel,
  notFoundCode: pi.PI_NOT_FOUND_CODE,
  isAvailable: () => canResolveCommand(pi.getPiCommand, pi.isPiNotFoundError),
  isNotFoundError: pi.isPiNotFoundError,
  run: pi.runPi,
  readSessionContext: async () => {
    throw new Error('A repository host is required for session context.');
  },
  sessionLaunchOptionKey: 'piSessionId',
});

/** @type {Record<'codex' | 'claude' | 'opencode' | 'pi', () => Agent>} */
const AGENT_FACTORIES = {
  claude: createClaudeAgent,
  codex: createCodexAgent,
  opencode: createOpenCodeAgent,
  pi: createPiAgent,
};

/** @param {unknown} value @returns {'codex' | 'claude' | 'opencode' | 'pi'} */
const normalizeAgentBackend = (value) =>
  value === 'codex' || value === 'claude' || value === 'opencode' || value === 'pi'
    ? value
    : DEFAULT_AGENT_BACKEND;

/** @param {unknown} backendId @returns {Agent} */
const getAgent = (backendId) => AGENT_FACTORIES[normalizeAgentBackend(backendId)]();

/**
 * @param {import('./host/repository-host.cjs').RepositoryHost} host
 * @param {unknown} backendId
 * @param {Partial<import('../core/config/types.ts').CodiffSettings>} [settings]
 * @returns {Agent}
 */
const getAgentForHost = (host, backendId, settings = {}) => {
  const agent = getAgent(backendId);
  const configuredCommand = (
    agent.id === 'codex'
      ? settings.codexCommand
      : agent.id === 'claude'
        ? settings.claudeCommand
        : ''
  )?.trim();
  const readers = {
    codex: readCodexSessionContext,
    claude: readClaudeSessionContext,
    opencode: readOpenCodeSessionContext,
    pi: readPiSessionContext,
  };
  const resolveCommand = async () => {
    const environment = await host.getEnvironment();
    return host.resolveCommand(environment[agent.cliPathEnvVar]?.trim() || agent.cliName);
  };
  return {
    ...agent,
    isAvailable: configuredCommand
      ? async () => Boolean(await host.resolveCommand('bash'))
      : host.id === 'local'
        ? agent.isAvailable
        : async () => Boolean(await resolveCommand()),
    readSessionContext: (sessionId) => readers[agent.id](host, sessionId),
    run:
      host.id === 'local' && !configuredCommand
        ? agent.run
        : async (root, prompt, schema, outputName, timeoutMessage, options) => {
            if (configuredCommand) {
              return agent.run(root, prompt, schema, outputName, timeoutMessage, {
                ...options,
                repositoryHost: host,
                commandTransport: await createBashCommandTransport(host, configuredCommand, root),
              });
            }
            const command = await resolveCommand();
            if (!command)
              throw Object.assign(new Error(`${agent.cliName} isn't installed on ${host.label}.`), {
                code: agent.notFoundCode,
              });
            const spawnOnHost = (
              /** @type {string} */ command,
              /** @type {ReadonlyArray<string>} */ args,
              /** @type {import('node:child_process').SpawnOptions} */ options = {},
            ) =>
              host.spawn(command, args, {
                cwd: options.cwd ? String(options.cwd) : root,
                env: /** @type {Record<string, string>} */ (options.env),
              });
            return agent.run(root, prompt, schema, outputName, timeoutMessage, {
              ...options,
              repositoryHost: host,
              commandTransport: {
                command,
                spawn: /** @type {typeof import('node:child_process').spawn} */ (
                  /** @type {unknown} */ (spawnOnHost)
                ),
              },
            });
          },
  };
};

/** @returns {ReadonlyArray<Agent>} */
const listAgents = () => AGENT_BACKENDS.map((id) => AGENT_FACTORIES[id]());

/**
 * @param {Agent} agent
 * @param {string} selectedModel
 * @param {Agent['models']} [models]
 * @returns {ReadonlyArray<{id: string; label: string}>}
 */
const getAgentMenuModels = (agent, selectedModel, models = agent.models) =>
  models.some((model) => model.id === selectedModel)
    ? models
    : [...models, { id: selectedModel, label: `Custom: ${selectedModel}` }];

/**
 * Select the first installed backend without launching a CLI process.
 * @param {(agent: Agent) => boolean} [isAvailable]
 * @returns {'codex' | 'claude' | 'opencode' | 'pi'}
 */
const detectInitialAgentBackend = (isAvailable = (agent) => agent.isAvailable() === true) =>
  listAgents().find(isAvailable)?.id ?? DEFAULT_AGENT_BACKEND;

module.exports = {
  detectInitialAgentBackend,
  getAgentMenuModels,
  getAgent,
  getAgentForHost,
  listAgents,
  normalizeAgentBackend,
};
