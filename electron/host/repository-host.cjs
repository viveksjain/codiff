// @ts-check

/**
 * The only way repository code reaches the machine a repository lives on.
 * Implementations: `LocalHost` (this machine) and `SshHost` (a remote machine
 * over a multiplexed ssh connection). Paths passed to a host are absolute
 * paths on that host's machine.
 *
 * Contract notes:
 * - `env` options add variables on top of the host's own environment and never
 *   replace it. For `SshHost` that is the ssh session's non-interactive
 *   environment.
 * - `exec` without `input` rejects with `Command failed: <command> <args>` and
 *   the command's stderr on the next line; with `input` it rejects with the
 *   stderr (or `<command> exited with status <code>`).
 * - `lstatMany` and `readFiles` keep input order; `lstatMany` maps any
 *   per-path failure to `null`, `readFiles` to an `Error`. Empty input
 *   resolves to `[]` without contacting the host.
 * - `writeFile({exclusive: true, mode})` fails if the path exists and sets
 *   exactly `mode`. Durability (`fsync`) is not part of the contract.
 *
 * @typedef {'directory' | 'file' | 'other' | 'symlink'} HostFileType
 * @typedef {{
 *   ctimeMs: number;
 *   ino: number;
 *   mode: number;
 *   mtimeMs: number;
 *   size: number;
 *   type: HostFileType;
 * }} HostStat
 * @typedef {{
 *   cwd?: string;
 *   env?: Readonly<Record<string, string>>;
 *   input?: string | Buffer;
 *   maxBuffer?: number;
 *   signal?: AbortSignal;
 * }} HostExecOptions
 * @typedef {{
 *   cwd?: string;
 *   env?: Readonly<Record<string, string>>;
 * }} HostSpawnOptions
 * @typedef {{
 *   cols: number;
 *   cwd?: string;
 *   env?: Readonly<Record<string, string>>;
 *   name: string;
 *   rows: number;
 * }} HostPtyOptions
 * @typedef {{exclusive?: boolean; mode?: number}} HostWriteFileOptions
 * @typedef {{
 *   kill: (signal?: NodeJS.Signals | number) => unknown;
 *   killed?: boolean;
 *   on: (event: string, listener: (...args: Array<any>) => void) => unknown;
 *   stderr: import('node:stream').Readable;
 *   stdin: import('node:stream').Writable;
 *   stdout: import('node:stream').Readable;
 * }} HostProcess
 * @typedef {{
 *   kill: () => void;
 *   onData: (listener: (data: string) => void) => {dispose: () => void};
 *   onExit: (listener: (event: {exitCode: number}) => void) => {dispose: () => void};
 * }} HostPty
 * @typedef {{
 *   id: string;
 *   label: string;
 *   exec: (command: string, args: ReadonlyArray<string>, options?: HostExecOptions) => Promise<Buffer>;
 *   spawn: (command: string, args: ReadonlyArray<string>, options?: HostSpawnOptions) => HostProcess;
 *   spawnPty: (command: string, args: ReadonlyArray<string>, options: HostPtyOptions) => HostPty;
 *   lstat: (path: string) => Promise<HostStat>;
 *   stat: (path: string) => Promise<HostStat>;
 *   lstatMany: (paths: ReadonlyArray<string>) => Promise<Array<HostStat | null>>;
 *   readFile: (path: string) => Promise<Buffer>;
 *   readFileTail: (path: string, maxBytes: number) => Promise<Buffer>;
 *   readdir: (path: string) => Promise<Array<{name: string; type: HostFileType}>>;
 *   getEnvironment: () => Promise<Readonly<Record<string, string>>>;
 *   resolveCommand: (name: string) => Promise<string | null>;
 *   readFiles: (paths: ReadonlyArray<string>) => Promise<Array<Buffer | Error>>;
 *   readlink: (path: string) => Promise<string>;
 *   realpath: (path: string) => Promise<string>;
 *   writeFile: (path: string, contents: string | Buffer, options?: HostWriteFileOptions) => Promise<void>;
 *   rename: (from: string, to: string) => Promise<void>;
 *   rm: (path: string, options?: {force?: boolean; recursive?: boolean}) => Promise<void>;
 *   mkdtemp: (prefix: string) => Promise<string>;
 * }} RepositoryHost
 */

module.exports = {};
