import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vite-plus/test';
import { createTemporaryDirectory } from '../../core/__tests__/helpers/resources.ts';

type ShellDialect = 'fish' | 'posix';

const require = createRequire(import.meta.url);
const { PID_MARKER, buildCommandScript, getShellDialect, quotePosix, wrapForLoginShell } =
  require('../host/shell-quote.cjs') as {
    PID_MARKER: string;
    buildCommandScript: (options: {
      announcePid?: boolean;
      args?: ReadonlyArray<string>;
      command: string;
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }) => string;
    getShellDialect: (shellPath: string) => ShellDialect | null;
    quotePosix: (value: string) => string;
    wrapForLoginShell: (script: string, dialect: ShellDialect) => string;
  };

const execFileAsync = promisify(execFile);

const findShell = (name: string) =>
  ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
    .map((directory) => `${directory}/${name}`)
    .find((path) => existsSync(path)) ?? null;

const shells = (['sh', 'bash', 'zsh', 'dash', 'fish'] as const).map((name) => ({
  dialect: (name === 'fish' ? 'fish' : 'posix') as ShellDialect,
  name,
  path: findShell(name),
}));

const dangerousValues = [
  '',
  'plain',
  'with space',
  "it's",
  "''",
  "'",
  'say "hi"',
  'back\\slash',
  '\\',
  "\\'",
  '\\b\\w+',
  '$HOME',
  '${HOME}',
  '`id`',
  '$(id)',
  '*',
  '?',
  '[a]',
  '~',
  '~/x',
  '!',
  '!!',
  '#comment',
  'line\nbreak',
  'tab\there',
  '-n',
  '--',
  ';',
  '&&',
  '|',
  '>',
  '%s',
  ' leading',
  'trailing ',
  'ünïcødé 🙂',
];

// Deterministic pseudo-random strings (mulberry32) over a hostile alphabet.
const randomValues = (count: number) => {
  let seed = 0x5eed;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = [...' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~\n\tabcXYZ019ü🙂'];
  return Array.from({ length: count }, () =>
    Array.from(
      { length: Math.floor(next() * 12) },
      () => alphabet[Math.floor(next() * alphabet.length)],
    ).join(''),
  );
};

const roundTrip = async (
  shellPath: string,
  dialect: ShellDialect,
  values: ReadonlyArray<string>,
) => {
  const script = buildCommandScript({ args: ['%s\\0', ...values], command: 'printf' });
  const { stdout } = await execFileAsync(shellPath, ['-c', wrapForLoginShell(script, dialect)], {
    encoding: 'buffer',
  });
  return stdout.toString('utf8').split('\0').slice(0, -1);
};

for (const shell of shells) {
  describe.skipIf(!shell.path)(`${shell.name} login shell`, () => {
    test('passes hostile arguments through byte for byte', async () => {
      expect(await roundTrip(shell.path!, shell.dialect, dangerousValues)).toEqual(dangerousValues);
    });

    test('passes random arguments through byte for byte', async () => {
      const values = randomValues(300);
      expect(await roundTrip(shell.path!, shell.dialect, values)).toEqual(values);
    });

    test('applies cwd and env exactly', async () => {
      await using directory = await createTemporaryDirectory("codiff quote 'dir' ");
      const script = buildCommandScript({
        args: ['-c', 'pwd -P; printf "%s" "$CODIFF_QUOTE"'],
        command: '/bin/sh',
        cwd: directory.path,
        env: { CODIFF_QUOTE: `a'b "c" $d \\e` },
      });
      const { stdout } = await execFileAsync(shell.path!, [
        '-c',
        wrapForLoginShell(script, shell.dialect),
      ]);
      const [cwd, value] = stdout.split('\n');
      expect(cwd.endsWith(directory.path.split('/').pop()!)).toBe(true);
      expect(value).toBe(`a'b "c" $d \\e`);
    });

    test('announces the PID of the command it executes', async () => {
      const script = buildCommandScript({
        announcePid: true,
        args: ['-c', 'echo "$$"'],
        command: '/bin/sh',
      });
      const { stderr, stdout } = await execFileAsync(shell.path!, [
        '-c',
        wrapForLoginShell(script, shell.dialect),
      ]);
      expect(stderr).toBe(`${PID_MARKER}${stdout.trim()}\n`);
    });
  });
}

test('getShellDialect recognizes supported login shells', () => {
  expect(getShellDialect('/bin/sh')).toBe('posix');
  expect(getShellDialect('/usr/bin/bash')).toBe('posix');
  expect(getShellDialect('/bin/zsh')).toBe('posix');
  expect(getShellDialect('/bin/dash')).toBe('posix');
  expect(getShellDialect('/bin/ksh')).toBe('posix');
  expect(getShellDialect('/opt/homebrew/bin/fish\n')).toBe('fish');
  expect(getShellDialect('/bin/tcsh')).toBeNull();
  expect(getShellDialect('/bin/csh')).toBeNull();
  expect(getShellDialect('/usr/bin/nu')).toBeNull();
  expect(getShellDialect('')).toBeNull();
});

test('quoting rejects NUL bytes', () => {
  expect(() => quotePosix('a\0b')).toThrow('Shell arguments cannot contain NUL bytes.');
  expect(() => buildCommandScript({ args: ['a\0b'], command: 'printf' })).toThrow('NUL');
});

test('env names must be valid identifiers', () => {
  expect(() => buildCommandScript({ command: 'true', env: { 'A=B': 'x' } })).toThrow(
    'Invalid environment variable name: A=B',
  );
});
