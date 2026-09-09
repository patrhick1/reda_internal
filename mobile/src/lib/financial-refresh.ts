import { useSyncExternalStore } from 'react';
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function notifyFinancialChange() {
  revision += 1;
  listeners.forEach((listener) => listener());
}
export function useFinancialRevision() {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => 0,
  );
}
