import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from 'vite-plus/test';
import {
  createTemporaryDirectory,
  createTemporaryEnvironment,
} from '../../core/__tests__/helpers/resources.ts';

const require = createRequire(import.meta.url);
const { getAgentForHost } = require('../agent.cjs');
const { createLocalHost } = require('../host/local-host.cjs');
const { createBashCommandTransport } = require('../agent-command.cjs');
const { readCodexModels } = require('../codex-models.cjs');

type WrapperCall = {
  args: string[];
  backend: string;
  cwd: string;
  marker: string;
  prefix: string;
};

const withWrapper = async (
  callback: (
    root: string,
    command: string,
    readCalls: () => Promise<WrapperCall[]>,
  ) => Promise<void>,
) => {
  await using directory = await createTemporaryDirectory('codiff-configured-agent-');
  const root = join(await realpath(directory.path), 'repo with spaces');
  await mkdir(root);
  const callsPath = join(directory.path, 'calls.jsonl');
  const wrapper = join(directory.path, 'isaac');
  await writeFile(
    wrapper,
    `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs');
const [backend, prefix, ...args] = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ backend, prefix, args, cwd: process.cwd(), marker: process.env.CODIFF_WRAPPER_TEST }) + '\\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
if (backend === 'codex' && args[0] === 'app-server') {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    if (message.method === 'model/list') send({ id: message.id, result: { data: [{ model: 'wrapper-model', displayName: 'Wrapper model' }], nextCursor: null } });
    if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'wrapper-thread' } } });
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'wrapper-turn' } } });
      send({ method: 'item/agentMessage/delta', params: { delta: '{"reply":"configured"}' } });
      send({ method: 'turn/completed', params: { turn: { status: 'completed', items: [] } } });
    }
  });
} else {
  process.stdin.resume();
  process.stdin.on('end', () => {
    if (backend === 'codex') writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"reply":"configured"}');
    else send({ structured_output: { reply: 'configured' } });
  });
}
`,
  );
  await chmod(wrapper, 0o755);
  await using _environment = createTemporaryEnvironment({
    CODIFF_CLAUDE_PATH: '/codiff-missing-default-claude',
    CODIFF_CODEX_PATH: '/codiff-missing-default-codex',
    PATH: `${directory.path}:${process.env.PATH}`,
    SHELL: undefined,
  });
  await callback(root, `export CODIFF_WRAPPER_TEST='shell value'; isaac`, async () =>
    (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  );
};

test.each([
  ['local', 'codex', 'gpt-6.1-sol'],
  ['local', 'claude', 'claude-sonnet-5-5'],
  ['ssh://devbox', 'codex', 'gpt-6.1-sol'],
  ['ssh://devbox', 'claude', 'claude-sonnet-5-5'],
])('runs %s %s through its configured Bash command', async (id, backend, model) => {
  await withWrapper(async (root, command, readCalls) => {
    const host = { ...createLocalHost(), id, label: 'devbox' };
    const agent = getAgentForHost(host, backend, {
      [`${backend}Command`]: `${command} ${backend} 'literal ; "quotes" $(printf unexpected)'`,
    });
    expect(await agent.isAvailable()).toBe(true);
    await expect(
      agent.run(root, 'A prompt with $variables and "quotes"\nand a newline.', {
        description: 'Preserve "quotes" and $(printf unexpected)',
        type: 'object',
      }),
    ).resolves.toBe('{"reply":"configured"}');
    const [call] = await readCalls();
    expect(call).toMatchObject({
      backend,
      cwd: root,
      marker: 'shell value',
      prefix: 'literal ; "quotes" $(printf unexpected)',
    });
    const modelFlag = backend === 'codex' ? '-m' : '--model';
    expect(call.args[call.args.indexOf(modelFlag) + 1]).toBe(model);
    expect(call.args).toContain(root);
    if (backend === 'claude') {
      expect(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1])).toEqual({
        description: 'Preserve "quotes" and $(printf unexpected)',
        type: 'object',
      });
    }
  });
});

test('uses the configured Codex command for streaming inference and model discovery', async () => {
  await withWrapper(async (root, command, readCalls) => {
    const host = createLocalHost();
    const codexCommand = `${command} codex prefix`;
    const agent = getAgentForHost(host, 'codex', { codexCommand });
    await expect(
      agent.run(root, 'prompt', {}, undefined, undefined, { onProgress: () => {} }),
    ).resolves.toBe('{"reply":"configured"}');
    const commandTransport = await createBashCommandTransport(host, codexCommand);
    await expect(readCodexModels({ commandTransport })).resolves.toEqual([
      { id: 'wrapper-model', label: 'Wrapper model', reasoningEfforts: [] },
    ]);
    const calls = await readCalls();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.backend === 'codex' && call.args[0] === 'app-server')).toBe(
      true,
    );
  });
});

test('reports when Bash is unavailable for a configured command', async () => {
  const host = { ...createLocalHost(), label: 'devbox', resolveCommand: async () => null };
  const agent = getAgentForHost(host, 'codex', { codexCommand: 'isaac codex' });
  expect(await agent.isAvailable()).toBe(false);
  await expect(agent.run('/repo', 'prompt', {})).rejects.toThrow(
    'Bash is required to run configured agent commands on devbox.',
  );
});
