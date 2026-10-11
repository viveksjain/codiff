import type { RepositoryState } from '../types.ts';
// Keep this browser-safe and in sync with electron/host/repository-identity.cjs.
export const getRepositoryStateKey = (state: Pick<RepositoryState, 'root' | 'hostId'>) =>
  !state.hostId || state.hostId === 'local' ? state.root : `${state.hostId}\0${state.root}`;
