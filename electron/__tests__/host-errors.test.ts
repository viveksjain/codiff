import { createRequire } from 'node:module';
import { expect, test } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const errors = require('../host/host-errors.cjs') as {
  HostAuthRequiredError: new (alias: string) => Error & { alias: string };
  HostDisconnectedError: new (
    alias: string,
    detail?: string,
  ) => Error & { alias: string; detail: string };
  HostUnreachableError: new (alias: string, detail: string) => Error & { alias: string };
  RemoteCommandMissingError: new (alias: string, command: string) => Error & { command: string };
  RemoteShellNoiseError: new (alias: string) => Error;
  UnsupportedRemoteShellError: new (alias: string, shell: string) => Error & { shell: string };
  classifySshFailure: (alias: string, stderr: string, options?: { connected?: boolean }) => Error;
};

test('host errors carry the spec messages and names', () => {
  expect(new errors.HostAuthRequiredError('devbox')).toMatchObject({
    alias: 'devbox',
    message: 'devbox needs interactive login. Run `codiff devbox:<path>` from a terminal.',
    name: 'HostAuthRequiredError',
  });
  expect(
    new errors.HostUnreachableError(
      'devbox',
      'ssh: connect to host devbox port 22: Connection refused',
    ),
  ).toMatchObject({
    message: 'ssh: connect to host devbox port 22: Connection refused',
    name: 'HostUnreachableError',
  });
  expect(new errors.HostUnreachableError('devbox', '').message).toBe('Could not reach devbox.');
  expect(new errors.HostDisconnectedError('devbox', 'broken pipe')).toMatchObject({
    detail: 'broken pipe',
    message: 'Lost connection to devbox.',
    name: 'HostDisconnectedError',
  });
  expect(new errors.UnsupportedRemoteShellError('devbox', '/bin/tcsh')).toMatchObject({
    message: 'Codiff needs a POSIX or fish login shell on devbox.',
    name: 'UnsupportedRemoteShellError',
    shell: '/bin/tcsh',
  });
  expect(new errors.RemoteCommandMissingError('devbox', 'git')).toMatchObject({
    command: 'git',
    message: "git isn't installed on devbox.",
    name: 'RemoteCommandMissingError',
  });
  expect(new errors.RemoteShellNoiseError('devbox').message).toBe(
    "devbox's shell startup files print output in non-interactive sessions, which breaks Codiff. Only print output in interactive shells.",
  );
});

test('authentication failures need an interactive login in every phase', () => {
  for (const stderr of [
    'vivek@devbox: Permission denied (publickey).',
    'Host key verification failed.',
    'Received disconnect from 10.0.0.2 port 22:2: Too many authentication failures',
    'Permission denied (publickey,keyboard-interactive).',
  ]) {
    expect(errors.classifySshFailure('devbox', stderr, { connected: false }).name).toBe(
      'HostAuthRequiredError',
    );
    expect(errors.classifySshFailure('devbox', stderr).name).toBe('HostAuthRequiredError');
  }
});

test('other failures are unreachable while connecting and disconnected afterwards', () => {
  const stderr =
    'ssh: Could not resolve hostname devbox: nodename nor servname provided, or not known\n';
  const connecting = errors.classifySshFailure('devbox', stderr, { connected: false });
  expect(connecting.name).toBe('HostUnreachableError');
  expect(connecting.message).toBe(stderr.trim());
  const session = errors.classifySshFailure('devbox', 'client_loop: send disconnect: Broken pipe');
  expect(session.name).toBe('HostDisconnectedError');
  expect(session.message).toBe('Lost connection to devbox.');
});
