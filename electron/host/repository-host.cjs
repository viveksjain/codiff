// @ts-check

/**
 * The only way repository code reaches the machine a repository lives on.
 * Implementations: `LocalHost` (this machine) and, in a later phase, `SshHost`.
 * Paths passed to a host are absolute paths on that host's machine.
 *
 * `env` options add variables on top of the host's own environment; they never
 * replace it.
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
 *   id: string;
 *   label: string;
 *   exec: (command: string, args: ReadonlyArray<string>, options?: HostExecOptions) => Promise<Buffer>;
 *   spawn: (command: string, args: ReadonlyArray<string>, options?: HostSpawnOptions) => import('node:child_process').ChildProcessWithoutNullStreams;
 *   spawnPty: (command: string, args: ReadonlyArray<string>, options: HostPtyOptions) => import('node-pty').IPty;
 *   lstat: (path: string) => Promise<HostStat>;
 *   stat: (path: string) => Promise<HostStat>;
 *   lstatMany: (paths: ReadonlyArray<string>) => Promise<Array<HostStat | null>>;
 *   readFile: (path: string) => Promise<Buffer>;
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
