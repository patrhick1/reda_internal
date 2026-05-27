import { useCallback, useState } from 'react';

/**
 * Manages a list of editable rows for multi-row admin forms (bulk transfer,
 * bulk receive, etc.). The hook is presentation-free — each screen owns its
 * row layout. Identity is tracked by an `id` field on every row so React
 * keys stay stable across add/remove/update.
 *
 * Always keeps at least one row in state (removing the last row replaces it
 * with a fresh empty one) so the form never becomes a dead-end.
 */
export function useBulkRows<T extends { id: string }>(makeNew: () => T) {
  const [rows, setRows] = useState<T[]>(() => [makeNew()]);

  const addRow = useCallback(() => {
    setRows((rs) => [...rs, makeNew()]);
  }, [makeNew]);

  const removeRow = useCallback(
    (id: string) => {
      setRows((rs) => {
        const next = rs.filter((r) => r.id !== id);
        return next.length === 0 ? [makeNew()] : next;
      });
    },
    [makeNew],
  );

  const updateRow = useCallback((id: string, patch: Partial<T>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const resetRows = useCallback(() => {
    setRows([makeNew()]);
  }, [makeNew]);

  return { rows, setRows, addRow, removeRow, updateRow, resetRows };
}
