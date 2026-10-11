import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vite-plus/test';
import { findSshd, startTestSshd } from './helpers/test-sshd.ts';
const require = createRequire(import.meta.url);
const { connectSshHost, createSshHost } = require('../host/ssh-host.cjs');
const { getAgentForHost } = require('../agent.cjs');
describe.skipIf(!findSshd())('remote agent execution', () => {
  test('all four backends and OpenCode session export use SSH with remote environment and cleanup', async () => {
    await using sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      sshConfigPath: sshd.sshConfigPath,
      controlDirectory: sshd.controlDirectory,
    });
    const directory = await host.mkdtemp('codiff-agent-test-');
    const removed: Array<string> = [];
    try {
      const command = join(directory, 'agent');
      await host.writeFile(
        command,
        `#!${process.execPath}\nconst fs=require('node:fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{if(process.env.REMOTE_ONLY!=='remote-value')process.exit(3);const args=process.argv.slice(2);const schema=args.indexOf('--output-schema');const output=args.indexOf('--output-last-message');if(schema>=0){fs.readFileSync(args[schema+1]);fs.writeFileSync(args[output+1],JSON.stringify({reply:'remote codex'}));}else if(args[0]==='run')console.log(JSON.stringify({type:'text',part:{id:'one',text:JSON.stringify({reply:'remote opencode'})}}));else if(args[0]==='export')console.log(JSON.stringify({info:{id:args[2]},messages:[{info:{role:'user'},parts:[{type:'text',text:'remote session'}]}]}));else if(args.includes('--print'))console.log(JSON.stringify({reply:'remote pi'}));else console.log(JSON.stringify({structured_output:{reply:'remote claude'}}));});\n`,
        { mode: 0o700 },
      );
      const boundHost = {
        ...host,
        getEnvironment: async () => ({
          HOME: directory,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          REMOTE_ONLY: 'remote-value',
          CODIFF_CLAUDE_PATH: command,
          CODIFF_CODEX_PATH: command,
          CODIFF_PI_PATH: command,
          CODIFF_OPENCODE_PATH: command,
        }),
        rm: async (path: string, options: unknown) => {
          removed.push(path);
          await host.rm(path, options);
        },
      };
      expect(await getAgentForHost(boundHost, 'claude').run(directory, 'prompt', {})).toBe(
        '{"reply":"remote claude"}',
      );
      expect(await getAgentForHost(boundHost, 'codex').run(directory, 'prompt', {})).toBe(
        '{"reply":"remote codex"}',
      );
      expect(await getAgentForHost(boundHost, 'pi').run(directory, 'prompt', {})).toBe(
        '{"reply":"remote pi"}',
      );
      expect(
        await getAgentForHost(boundHost, 'opencode').run(
          directory,
          'prompt',
          {},
          undefined,
          undefined,
          { onProgress: () => {} },
        ),
      ).toBe('{"reply":"remote opencode"}');
      expect(
        await getAgentForHost(boundHost, 'opencode').readSessionContext('ses_abcdefgh1234'),
      ).toMatchObject({ messages: [{ role: 'user', text: 'remote session' }] });
      expect(removed).toHaveLength(2);
      await expect(host.stat(removed[0])).rejects.toThrow();
    } finally {
      await host.rm(directory, { recursive: true, force: true });
      await host.close();
    }
  }, 15000);
  test('an agent ignoring TERM is killed remotely on timeout and its outputs are removed', async () => {
    await using sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      sshConfigPath: sshd.sshConfigPath,
      controlDirectory: sshd.controlDirectory,
    });
    const directory = await host.mkdtemp('codiff-agent-timeout-');
    try {
      const command = join(directory, 'agent');
      const pidFile = join(directory, 'pid');
      const workerFile = join(directory, 'worker-pid');
      await host.writeFile(
        command,
        `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(workerFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,
        { mode: 0o700 },
      );
      const removed: Array<string> = [];
      const boundHost = {
        ...host,
        getEnvironment: async () => ({
          HOME: directory,
          PATH: '/usr/bin:/bin',
          CODIFF_CODEX_PATH: command,
          CODIFF_PI_PATH: command,
          CODIFF_OPENCODE_PATH: command,
        }),
        rm: async (path: string, options: unknown) => {
          removed.push(path);
          await host.rm(path, options);
        },
      };
      await expect(
        getAgentForHost(boundHost, 'codex').run(
          directory,
          'prompt',
          {},
          undefined,
          'remote timeout',
          { timeoutMs: 750 },
        ),
      ).rejects.toThrow('remote timeout');
      const pid = (await host.readFile(pidFile)).toString();
      await expect(host.exec('kill', ['-0', pid])).rejects.toThrow();
      const workerPid = (await host.readFile(workerFile)).toString();
      try {
        await vi.waitFor(async () => {
          await expect(host.exec('kill', ['-0', workerPid])).rejects.toThrow();
        });
      } finally {
        await host.exec('/bin/sh', ['-c', 'kill -KILL "$1" 2>/dev/null; :', 'sh', workerPid]);
      }
      expect(removed).toHaveLength(1);
      await expect(host.stat(removed[0])).rejects.toThrow();
    } finally {
      await host.rm(directory, { recursive: true, force: true });
      await host.close();
    }
  }, 15000);
  test('login environment capture forcefully stops a shell ignoring TERM on timeout', async () => {
    await using sshd = await startTestSshd();
    const transportHost = await connectSshHost({
      alias: sshd.alias,
      sshConfigPath: sshd.sshConfigPath,
      controlDirectory: sshd.controlDirectory,
    });
    const directory = await transportHost.mkdtemp('codiff-env-timeout-');
    const shell = join(directory, 'shell');
    const pidFile = join(directory, 'pid');
    await transportHost.writeFile(
      shell,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`,
      { mode: 0o700 },
    );
    const { createSshConnection } = require('../host/ssh-connection.cjs');
    const connection = createSshConnection({
      alias: sshd.alias,
      sshConfigPath: sshd.sshConfigPath,
      controlDirectory: sshd.controlDirectory,
    });
    const host = createSshHost({
      alias: sshd.alias,
      connection,
      dialect: 'posix',
      statFlavor: 'bsd',
      loginShell: shell,
    });
    const realTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(750));
    try {
      await expect(host.getEnvironment()).rejects.toThrow();
      const pid = (await transportHost.readFile(pidFile)).toString();
      try {
        await vi.waitFor(async () => {
          await expect(transportHost.exec('kill', ['-0', pid])).rejects.toThrow();
        });
      } finally {
        await transportHost.exec('/bin/sh', ['-c', 'kill -KILL "$1" 2>/dev/null; :', 'sh', pid]);
      }
    } finally {
      timeout.mockRestore();
      await transportHost.rm(directory, { recursive: true, force: true });
      await host.close();
      await transportHost.close();
    }
  }, 15000);
  test('a TERM-resistant command can be escalated after the remote signal is delivered', async () => {
    await using sshd = await startTestSshd();
    const host = await connectSshHost({
      alias: sshd.alias,
      sshConfigPath: sshd.sshConfigPath,
      controlDirectory: sshd.controlDirectory,
    });
    const directory = await host.mkdtemp('codiff-escalation-');
    const command = join(directory, 'agent');
    const pidFile = join(directory, 'pid');
    const termFile = join(directory, 'term');
    try {
      await host.writeFile(
        command,
        `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(termFile)},'received'));setInterval(()=>{},1000);\n`,
        { mode: 0o700 },
      );
      const child = host.spawn(command, [], {});
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.end();
      await vi.waitFor(async () =>
        expect((await host.readFile(pidFile)).toString()).toMatch(/^\d+$/),
      );
      child.kill('SIGTERM');
      await vi.waitFor(async () =>
        expect((await host.readFile(termFile)).toString()).toBe('received'),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        expect(child.kill('SIGKILL')).toBe(true);
        expect(child.kill('SIGKILL')).toBe(false);
        const pid = (await host.readFile(pidFile)).toString();
        await vi.waitFor(async () => {
          await expect(host.exec('kill', ['-0', pid])).rejects.toThrow();
        });
      } finally {
        const pid = (await host.readFile(pidFile)).toString();
        await host.exec('/bin/sh', ['-c', 'kill -KILL "$1" 2>/dev/null; :', 'sh', pid]);
      }
    } finally {
      await host.rm(directory, { recursive: true, force: true });
      await host.close();
    }
  }, 15000);
});
