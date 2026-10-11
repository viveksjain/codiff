import { Button } from './Button.tsx';
export function RepositoryConnectionBanner({
  error,
  label,
  onReconnect,
  reconnecting,
}: {
  error: string | null;
  label: string;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  return (
    <div className="repository-change-banner visible repository-connection-banner" role="alert">
      <span>
        Lost connection to {label}.{error ? ` ${error}` : ''}
      </span>
      <Button disabled={reconnecting} onClick={onReconnect} type="button">
        {reconnecting ? 'Reconnecting…' : 'Reconnect'}
      </Button>
    </div>
  );
}
