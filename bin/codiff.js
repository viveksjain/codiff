#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import {
  formatHelpText,
  getReviewSource,
  parseArguments,
  resolvePullRequestTargetUrl,
} from './arguments.js';
import { completionShells, generateCompletionScript } from './completions.js';
import { waitForPlanResult } from './plan-result.js';
import { createRemoteHandoff } from './remote-handoff.js';
import { runUpdateCommand } from './update-command.js';
import { getUpdateNotice } from './update-notice.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const {
  generateAndShareWalkthrough,
  shareWalkthroughFile,
} = require('../electron/headless-walkthrough-share.cjs');
const { sharePlanFile } = require('../electron/headless-plan-share.cjs');
const { createLocalHost } = require('../electron/host/local-host.cjs');
const localHost = createLocalHost();
const { createSshConnection } = require('../electron/host/ssh-connection.cjs');
const { connectSshHost } = require('../electron/host/ssh-host.cjs');
const {
  formatRemoteRepositoryTarget,
  resolveRemoteRepository,
  resolveRemoteSource,
} = require('../electron/host/repository-target.cjs');
const { getCommandEnvironment } = require('../electron/login-shell-environment.cjs');

// The renderer is the built dist/ by default. When Codiff's own Vite dev server
// is running, use it instead so source edits hot-reload without a rebuild. The
// server is VERIFIED to identify as Codiff before it's trusted — 5173 is a
// common dev port, so "something is listening" is never enough on its own.
const DEV_SERVER_URL = process.env.CODIFF_DEV_SERVER_URL || 'http://127.0.0.1:5173';

const looksLikeCodiff = (body) =>
  body.includes('<title>Codiff</title>') && body.includes('/core/index.tsx');

/** Resolve to the dev-server URL when it is up and serving Codiff, else `null`. */
const detectDevServer = (url) =>
  new Promise((resolveProbe) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolveProbe(value ? url : null);
      }
    };

    let target;
    try {
      target = new URL(url);
    } catch {
      finish(false);
      return;
    }

    const request = (target.protocol === 'https:' ? https : http).get(target, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(false);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65_536) {
          response.destroy();
        }
      });
      response.on('end', () => finish(looksLikeCodiff(body)));
      response.on('close', () => finish(looksLikeCodiff(body)));
    });
    request.setTimeout(800, () => {
      request.destroy();
      finish(false);
    });
    request.on('error', () => finish(false));
  });

const openExternal = (url) =>
  new Promise((resolveOpen, reject) => {
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '""', url] : [url];
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveOpen();
    });
  });

// Assemble the narrative walkthrough authoring guide: the prose, then the live
// schema object serialized inline (single-sourced from the validator — no copy).
const buildWalkthroughGuide = () => {
  const { narrativeWalkthroughSchema } = require(
    resolve(root, 'electron/narrative-walkthrough.cjs'),
  );
  const guide = readFileSync(resolve(root, 'bin/walkthrough-guide.md'), 'utf8').trimEnd();
  return `${guide}\n\n\`\`\`json\n${JSON.stringify(narrativeWalkthroughSchema, null, 2)}\n\`\`\`\n`;
};

const runCodiffUpdate = () => {
  const appBundleMatch = process.platform === 'darwin' ? root.match(/^(.*\.app)\//) : null;
  return runUpdateCommand({
    currentVersion: packageJson.version,
    isSourceCheckout: existsSync(resolve(root, '.git')),
    log: (line) => process.stdout.write(`${line}\n`),
    openApp: appBundleMatch
      ? () => {
          spawn('open', ['-n', appBundleMatch[1], '--args', '--apply-update'], {
            detached: true,
            stdio: 'ignore',
          }).unref();
        }
      : null,
  });
};

let remoteHandoff;
let remoteShareHost;
const run = async () => {
  const rawArguments = process.argv.slice(2);
  if (rawArguments.length === 1 && rawArguments[0] === 'update') {
    process.exitCode = await runCodiffUpdate();
    return;
  }

  const parsedArguments = parseArguments(process.argv.slice(2));

  if (parsedArguments.help) {
    process.stdout.write(formatHelpText(packageJson.version));
    return;
  }

  if (parsedArguments.version) {
    process.stdout.write(`codiff v${packageJson.version}\n`);
    const notice = getUpdateNotice({ currentVersion: packageJson.version });
    if (notice) {
      process.stderr.write(`${notice}\n`);
    }
    return;
  }

  if (parsedArguments.completionShell != null) {
    const shell = parsedArguments.completionShell;
    if (!shell) {
      process.stderr.write(
        `codiff: --completions requires a shell: ${completionShells.join(', ')}.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (!completionShells.includes(shell)) {
      process.stderr.write(
        `codiff: unsupported shell for --completions: ${shell}. Supported shells: ${completionShells.join(', ')}.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(generateCompletionScript(shell));
    return;
  }

  if (parsedArguments.walkthroughGuide) {
    process.stdout.write(buildWalkthroughGuide());
    return;
  }

  if (parsedArguments.remoteTarget) {
    if (process.platform === 'win32') {
      throw new Error('Remote repositories require macOS or Linux.');
    }
    if (
      parsedArguments.pullRequestUrl ||
      parsedArguments.pullRequestNumber ||
      parsedArguments.pullRequestBranch
    ) {
      throw new Error('PR/MR reviews are unavailable for remote repositories.');
    }
    if (parsedArguments.planFilePath) {
      throw new Error('Plan reviews are unavailable for remote repositories.');
    }
    const target = parsedArguments.remoteTarget;
    const connection = createSshConnection({
      ...target,
      interactive: true,
      getLocalEnvironment: getCommandEnvironment,
    });
    const adopted = await connection.check();
    remoteHandoff = createRemoteHandoff(connection, adopted);
    await connection.ensureMaster();
    const host = await connectSshHost({
      alias: target.alias,
      connection: {
        ...connection,
        exitMaster: () => remoteHandoff.cleanup(),
      },
    });
    if (parsedArguments.share) remoteShareHost = host;
    parsedArguments.requestedPath = await resolveRemoteRepository(host, target.path);
    const source = await resolveRemoteSource(host, parsedArguments.requestedPath, {
      candidate: parsedArguments.remoteSourceCandidate,
      range: parsedArguments.range,
    });
    if (source?.type === 'branch-working-tree') {
      parsedArguments.branchRef = source.ref;
    }
    // Leave the master alive for the app to adopt using the same destination,
    // port, and ControlPath. The app owns its lifetime after the handoff.
  }

  const {
    agentBackend,
    branchRef,
    claudeSessionId,
    codexSessionId,
    commitRef,
    opencodeSessionId,
    piSessionId,
    planFilePath,
    public: forcePublic,
    pullRequestBranch,
    pullRequestNumber,
    pullRequestProvider,
    range,
    requestedPath,
    share,
    walkthrough,
    walkthroughContextPath,
    walkthroughFilePath,
  } = parsedArguments;
  let { pullRequestUrl } = parsedArguments;

  if (planFilePath && (!existsSync(planFilePath) || !/\.md$/i.test(planFilePath))) {
    process.stderr.write(`codiff: plan file not found or not Markdown: ${planFilePath}\n`);
    process.exitCode = 1;
    return;
  }
  if (!pullRequestUrl && (pullRequestBranch || pullRequestNumber != null)) {
    try {
      pullRequestUrl = resolvePullRequestTargetUrl({
        branch: pullRequestBranch,
        number: pullRequestNumber,
        provider: pullRequestProvider ?? undefined,
        repositoryPath: requestedPath,
        url: pullRequestUrl,
      });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  if (share) {
    if (planFilePath) {
      const sessionId =
        agentBackend === 'claude'
          ? claudeSessionId
          : agentBackend === 'opencode'
            ? opencodeSessionId
            : agentBackend === 'pi'
              ? piSessionId
              : codexSessionId;
      try {
        const url = await sharePlanFile(localHost, {
          agent: agentBackend ?? undefined,
          codiffVersion: packageJson.version,
          forcePublic,
          openExternal,
          planFile: planFilePath,
          repositoryPath: requestedPath,
          serviceUrlOverride: process.env.CODIFF_SHARE_SERVER_URL,
          sessionId: sessionId ?? undefined,
        });
        process.stdout.write(`${url}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
      return;
    }

    const source = getReviewSource({
      branchRef,
      commitRef,
      pullRequestProvider,
      pullRequestUrl,
      range,
    });

    try {
      const commonOptions = {
        agent: agentBackend ?? undefined,
        codiffVersion: packageJson.version,
        forcePublic,
        openExternal,
        repositoryPath: requestedPath,
        serviceUrlOverride: process.env.CODIFF_SHARE_SERVER_URL,
        source,
      };
      const url = walkthroughFilePath
        ? await shareWalkthroughFile(remoteShareHost || localHost, {
            ...commonOptions,
            walkthroughFile: walkthroughFilePath,
          })
        : await generateAndShareWalkthrough(remoteShareHost || localHost, {
            ...commonOptions,
            claudeSessionId,
            codexSessionId,
            opencodeSessionId,
            piSessionId,
            walkthroughContextPath,
          });
      process.stdout.write(`${url}\n`);
      return;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  // Prefer an explicit ELECTRON_RENDERER_URL; otherwise auto-use Codiff's dev
  // server when it is actually running and identifies as Codiff.
  const rendererURL =
    process.env.ELECTRON_RENDERER_URL || (await detectDevServer(DEV_SERVER_URL)) || '';

  if (!rendererURL && !existsSync(resolve(root, 'dist/index.html'))) {
    throw new Error('Codiff has not been built yet. Run `pnpm build` first, or start `pnpm dev`.');
  }

  const planResultDirectory = planFilePath
    ? mkdtempSync(join(tmpdir(), 'codiff-plan-result-'))
    : null;
  const planResultPath = planResultDirectory ? join(planResultDirectory, 'result.json') : '';
  const childEnv = {
    ...process.env,
    CODIFF_AGENT_BACKEND: agentBackend ?? '',
    CODIFF_BRANCH_REF: branchRef ?? '',
    CODIFF_CLAUDE_SESSION_ID: claudeSessionId ?? '',
    CODIFF_COMMIT_REF: commitRef ?? '',
    CODIFF_CODEX_SESSION_ID: codexSessionId ?? '',
    CODIFF_OPENCODE_SESSION_ID: opencodeSessionId ?? '',
    CODIFF_PI_SESSION_ID: piSessionId ?? '',
    CODIFF_PLAN_FILE: planFilePath ?? '',
    CODIFF_PLAN_RESULT_FILE: planResultPath,
    CODIFF_PULL_REQUEST_URL: pullRequestUrl ?? '',
    CODIFF_REVIEW_PROVIDER: pullRequestProvider ?? '',
    CODIFF_RANGE: range ? `${range.base}${range.symmetric ? '...' : '..'}${range.head}` : '',
    CODIFF_REPOSITORY_PATH: requestedPath,
    CODIFF_REMOTE_TARGET: parsedArguments.remoteTarget
      ? formatRemoteRepositoryTarget({ ...parsedArguments.remoteTarget, path: requestedPath })
      : '',
    CODIFF_WALKTHROUGH: walkthrough ? '1' : '',
    CODIFF_WALKTHROUGH_CONTEXT: walkthroughContextPath ?? '',
    CODIFF_WALKTHROUGH_FILE: walkthroughFilePath ?? '',
    ELECTRON_RENDERER_URL: rendererURL,
  };

  // Electron must launch as a GUI. Some launchers (e.g. an agent/CLI harness)
  // export ELECTRON_RUN_AS_NODE=1, which makes the electron binary run as plain
  // Node — `require('electron')` then returns a path string and the app crashes
  // on boot. Strip it (and the console-detach flag) so the window always opens.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;

  const updateNotice = getUpdateNotice({ currentVersion: packageJson.version });
  if (updateNotice) {
    process.stderr.write(`${updateNotice}\n`);
  }

  const appBundlePath = root.match(/^(.*\.app)\/Contents\/Resources\/app$/)?.[1];
  const electron = appBundlePath
    ? join(appBundlePath, 'Contents/MacOS/codiff')
    : (await import('electron')).default;

  const spawnElectron = () =>
    spawn(electron, appBundlePath ? [] : [root], {
      detached: true,
      env: childEnv,
      stdio: 'ignore',
    });
  const child = remoteHandoff ? await remoteHandoff.launch(spawnElectron) : spawnElectron();

  child.unref();
  if (planResultDirectory) {
    try {
      const result = await waitForPlanResult(planResultPath, child);
      if (result.status === 'canceled') {
        process.exitCode = 2;
      } else {
        process.stdout.write(`CODIFF_PLAN_RESULT ${JSON.stringify(result)}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Codiff could not open the plan.'}\n`,
      );
      process.exitCode = 1;
    } finally {
      rmSync(planResultDirectory, { force: true, recursive: true });
    }
  }
};

run()
  .catch((error) => {
    process.stderr.write(`codiff: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await remoteShareHost?.close();
    await remoteHandoff?.cleanup();
  });
