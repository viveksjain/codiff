// @ts-check

const { contextBridge, ipcRenderer } = require('electron');

const applyPlatformAttribute = () => {
  document.documentElement?.setAttribute('data-codiff-platform', process.platform);
};

if (document.documentElement) {
  applyPlatformAttribute();
} else {
  window.addEventListener('DOMContentLoaded', applyPlatformAttribute, { once: true });
}

let repositoryStateRequestId = 0;

/** @type {Window['codiff']} */
const codiff = {
  askReviewAssistant: (request) => ipcRenderer.invoke('codiff:askReviewAssistant', request),
  createWalkthroughCommit: (request) =>
    ipcRenderer.invoke('codiff:createWalkthroughCommit', request),
  completePlan: (review, status) => ipcRenderer.invoke('codiff:completePlan', review, status),
  updateWalkthroughCommitMessage: (request) =>
    ipcRenderer.invoke('codiff:updateWalkthroughCommitMessage', request),
  getAgentSkillStatus: () => ipcRenderer.invoke('codiff:getAgentSkillStatus'),
  getConfig: () => ipcRenderer.invoke('codiff:getConfig'),
  decreaseCodeFontSize: () => ipcRenderer.invoke('codiff:decreaseCodeFontSize'),
  getDiffSectionContent: (request) => ipcRenderer.invoke('codiff:getDiffSectionContent', request),
  getFeatureFlags: () => ipcRenderer.invoke('codiff:getFeatureFlags'),
  getDiffImageContent: (request) => ipcRenderer.invoke('codiff:getDiffImageContent', request),
  getGitIdentity: () => ipcRenderer.invoke('codiff:getGitIdentity'),
  getKeyboardLayout: () => ipcRenderer.invoke('codiff:getKeyboardLayout'),
  getLaunchOptions: () => ipcRenderer.invoke('codiff:getLaunchOptions'),
  getMarkdownDocument: (request) => ipcRenderer.invoke('codiff:getMarkdownDocument', request),
  getRepositoryFile: (path) => ipcRenderer.invoke('codiff:getRepositoryFile', path),
  getPreferences: () => ipcRenderer.invoke('codiff:getPreferences'),
  getPlanReview: () => ipcRenderer.invoke('codiff:getPlanReview'),
  getRepositoryHistory: (limit, source) =>
    ipcRenderer.invoke('codiff:getRepositoryHistory', limit, source),
  getRepositoryState: async (source, onTrackedState) => {
    if (!onTrackedState) {
      return ipcRenderer.invoke('codiff:getRepositoryState', source);
    }
    const requestId = ++repositoryStateRequestId;
    const listener = (
      /** @type {Electron.IpcRendererEvent} */ _event,
      /** @type {number} */ id,
      /** @type {import('../core/types.ts').RepositoryState} */ state,
    ) => {
      if (id === requestId) {
        onTrackedState(state);
      }
    };
    ipcRenderer.on('codiff:repositoryTrackedState', listener);
    try {
      return await ipcRenderer.invoke('codiff:getRepositoryState', source, requestId);
    } finally {
      ipcRenderer.removeListener('codiff:repositoryTrackedState', listener);
    }
  },
  getTerminalHelperStatus: () => ipcRenderer.invoke('codiff:getTerminalHelperStatus'),
  getNarrativeWalkthrough: (snapshot, options) =>
    ipcRenderer.invoke('codiff:getNarrativeWalkthrough', snapshot, options),
  installAgentSkill: () => ipcRenderer.invoke('codiff:installAgentSkill'),
  installTerminalHelper: () => ipcRenderer.invoke('codiff:installTerminalHelper'),
  increaseCodeFontSize: () => ipcRenderer.invoke('codiff:increaseCodeFontSize'),
  isWindowFullScreen: () => ipcRenderer.invoke('codiff:isWindowFullScreen'),
  markPlanReady: () => ipcRenderer.invoke('codiff:markPlanReady'),
  onConfigChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {import('../core/config/types.ts').CodiffConfig} nextConfig */
    const listener = (_event, nextConfig) => callback(nextConfig);
    ipcRenderer.on('codiff:configChanged', listener);
    return () => ipcRenderer.removeListener('codiff:configChanged', listener);
  },
  onCopyPendingCommentsRequest: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {number} requestId */
    const listener = (_event, requestId) => {
      Promise.resolve(callback()).then(
        (markdown) => {
          ipcRenderer.send(
            'codiff:copyPendingCommentsResult',
            requestId,
            typeof markdown === 'string' ? markdown : '',
          );
        },
        () => {
          ipcRenderer.send('codiff:copyPendingCommentsResult', requestId, '');
        },
      );
    };
    ipcRenderer.on('codiff:copyPendingCommentsRequest', listener);
    return () => ipcRenderer.removeListener('codiff:copyPendingCommentsRequest', listener);
  },
  onFindInDiffs: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('codiff:findInDiffs', listener);
    return () => ipcRenderer.removeListener('codiff:findInDiffs', listener);
  },
  onKeyboardLayoutChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {import('../core/config/keyboard-layout.ts').NativeKeyboardLayout} layout */
    const listener = (_event, layout) => callback(layout);
    ipcRenderer.on('codiff:keyboardLayoutChanged', listener);
    return () => ipcRenderer.removeListener('codiff:keyboardLayoutChanged', listener);
  },
  onOpenReviewSource: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {import('../core/types.ts').OpenReviewSourceKind} kind */
    const listener = (_event, kind) => callback(kind);
    ipcRenderer.on('codiff:openReviewSource', listener);
    return () => ipcRenderer.removeListener('codiff:openReviewSource', listener);
  },
  onMarkdownDocumentChanged: (callback) => {
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('codiff:markdownDocumentChanged', listener);
    return () => ipcRenderer.removeListener('codiff:markdownDocumentChanged', listener);
  },
  onPlanCloseRequested: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('codiff:planCloseRequested', listener);
    return () => ipcRenderer.removeListener('codiff:planCloseRequested', listener);
  },
  onWalkthroughCommitOutput: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {string} chunk */
    const listener = (_event, chunk) => callback(String(chunk));
    ipcRenderer.on('codiff:walkthroughCommitOutput', listener);
    return () => ipcRenderer.removeListener('codiff:walkthroughCommitOutput', listener);
  },
  onWindowFullScreenChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {boolean} isFullScreen */
    const listener = (_event, isFullScreen) => callback(Boolean(isFullScreen));
    ipcRenderer.on('codiff:windowFullScreenChanged', listener);
    return () => ipcRenderer.removeListener('codiff:windowFullScreenChanged', listener);
  },
  getRepositoryHost: () => ipcRenderer.invoke('codiff:getRepositoryHost'),
  openRemoteRepository: (target) => ipcRenderer.invoke('codiff:openRemoteRepository', target),
  reconnectRepositoryHost: () => ipcRenderer.invoke('codiff:reconnectRepositoryHost'),
  onRepositoryHostChanged: (callback) => {
    const listener = (
      /** @type {Electron.IpcRendererEvent} */ _event,
      /** @type {import('../core/types.ts').RepositoryHostInfo} */ info,
    ) => callback(info);
    ipcRenderer.on('codiff:repositoryHostChanged', listener);
    return () => ipcRenderer.removeListener('codiff:repositoryHostChanged', listener);
  },
  onOpenRemoteRepositoryRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('codiff:openRemoteRepositoryRequest', listener);
    return () => ipcRenderer.removeListener('codiff:openRemoteRepositoryRequest', listener);
  },
  onRepositoryChanged: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {{root: string}} change */
    const listener = (_event, change) => callback(change);
    ipcRenderer.on('codiff:repositoryChanged', listener);
    return () => ipcRenderer.removeListener('codiff:repositoryChanged', listener);
  },
  onWalkthroughProgress: (callback) => {
    /** @param {Electron.IpcRendererEvent} _event @param {import('../core/types.ts').WalkthroughProgressEvent} progress */
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('codiff:walkthroughProgress', listener);
    return () => ipcRenderer.removeListener('codiff:walkthroughProgress', listener);
  },
  onRefreshRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('codiff:refreshRequest', listener);
    return () => ipcRenderer.removeListener('codiff:refreshRequest', listener);
  },
  findDefinitions: (request) => ipcRenderer.invoke('codiff:findDefinitions', request),
  openConfigFile: () => ipcRenderer.invoke('codiff:openConfigFile'),
  openFile: (path, lineNumber) => ipcRenderer.invoke('codiff:openFile', path, lineNumber),
  openRepositoryFolder: () => ipcRenderer.invoke('codiff:openRepositoryFolder'),
  resolvePullRequestUrl: (value) => ipcRenderer.invoke('codiff:resolvePullRequestUrl', value),
  setDiffStyle: (value) => ipcRenderer.invoke('codiff:setDiffStyle', value),
  setShowOutdated: (value) => ipcRenderer.invoke('codiff:setShowOutdated', value),
  setWordWrap: (value) => ipcRenderer.invoke('codiff:setWordWrap', value),
  sharePlan: (review) => ipcRenderer.invoke('codiff:sharePlan', review),
  shareWalkthrough: (snapshot) => ipcRenderer.invoke('codiff:shareWalkthrough', snapshot),
  resetCodeFontSize: () => ipcRenderer.invoke('codiff:resetCodeFontSize'),
  saveMarkdownDocument: (request) => ipcRenderer.invoke('codiff:saveMarkdownDocument', request),
  saveRepositoryFile: (request) => ipcRenderer.invoke('codiff:saveRepositoryFile', request),
  savePlanReview: (review) => ipcRenderer.invoke('codiff:savePlanReview', review),
  showInFolder: (path) => ipcRenderer.invoke('codiff:showInFolder', path),
  submitPullRequestComment: (request) =>
    ipcRenderer.invoke('codiff:submitPullRequestComment', request),
  submitPullRequestReview: (request) =>
    ipcRenderer.invoke('codiff:submitPullRequestReview', request),
};

contextBridge.exposeInMainWorld('codiff', codiff);
