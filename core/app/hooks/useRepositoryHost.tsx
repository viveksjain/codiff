import { useCallback, useEffect, useState } from 'react';
import type { RepositoryHostInfo } from '../../types.ts';
import { OpenRemoteRepositoryDialog } from '../components/OpenRemoteRepositoryDialog.tsx';
import { RepositoryConnectionBanner } from '../components/RepositoryConnectionBanner.tsx';
import type { CodeEditingStore } from './code-editing-store.ts';
const localHost: RepositoryHostInfo = {
  id: 'local',
  label: '',
  recentTargets: [],
  remote: false,
  state: 'connected',
};
export function useRepositoryHost(store: CodeEditingStore) {
  const [hostInfo, setHostInfo] = useState(localHost);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = useCallback(
    (info: RepositoryHostInfo) => {
      store.setWritable(info.state === 'connected');
      setHostInfo(info);
      if (info.state === 'connected') {
        setError(null);
      }
    },
    [store],
  );
  useEffect(() => {
    let disposed = false;
    let changed = false;
    const unsubscribe = window.codiff.onRepositoryHostChanged?.((info) => {
      changed = true;
      if (!disposed) {
        accept(info);
      }
    });
    void window.codiff
      .getRepositoryHost?.()
      .then((info) => {
        if (!disposed && !changed) {
          accept(info);
        }
      })
      .catch(() => {});
    const closeRequest = window.codiff.onOpenRemoteRepositoryRequest?.(() => setDialogOpen(true));
    return () => {
      disposed = true;
      unsubscribe?.();
      closeRequest?.();
    };
  }, [accept]);
  const reconnect = useCallback(() => {
    setReconnecting(true);
    setError(null);
    void window.codiff
      .reconnectRepositoryHost()
      .then(accept)
      .catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)))
      .finally(() => setReconnecting(false));
  }, [accept]);
  const openRemoteDialog = useCallback(() => setDialogOpen(true), []);
  const disconnected = hostInfo.remote && hostInfo.state !== 'connected';
  return {
    connectionBanner: disconnected ? (
      <RepositoryConnectionBanner
        error={error}
        label={hostInfo.label}
        onReconnect={reconnect}
        reconnecting={reconnecting}
      />
    ) : null,
    disconnected,
    hostInfo,
    openRemoteDialog,
    remoteDialog: dialogOpen ? (
      <OpenRemoteRepositoryDialog
        onClose={() => setDialogOpen(false)}
        recentTargets={hostInfo.recentTargets}
      />
    ) : null,
  };
}
