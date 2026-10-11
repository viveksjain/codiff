import { OpenReviewSourceDialog } from './OpenReviewSourceDialog.tsx';
export function OpenRemoteRepositoryDialog({
  onClose,
  recentTargets,
}: {
  onClose: () => void;
  recentTargets: ReadonlyArray<string>;
}) {
  return (
    <OpenReviewSourceDialog
      kind="remote"
      onClose={onClose}
      onOpen={window.codiff.openRemoteRepository}
      recentTargets={recentTargets}
    />
  );
}
