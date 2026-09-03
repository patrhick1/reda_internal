import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { removeCustomerBlacklist } from '@/services/blacklist';

/** Close a blacklist entry. The entry stays as history and the removal is
 *  audited; the number can order again immediately. */
export function RemoveBlacklistSheet({
  open,
  entry,
  onClose,
  onRemoved,
}: {
  open: boolean;
  entry: { id: string; phone_display: string; reason: string } | null;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setNote('');
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (!entry) return;
    setSubmitting(true);
    setError(null);
    try {
      await removeCustomerBlacklist(entry.id, note.trim() || null);
      onRemoved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!entry) return null;

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="Remove from blacklist"
      subtitle={entry.phone_display}
    >
      <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
        <Banner tone="info" icon="phoneOff">
          {`Listed for: ${entry.reason}. Once removed, orders from this number go through again right away. The entry stays in the history and the removal is logged.`}
        </Banner>

        <Input
          label="Note (optional)"
          value={note}
          onChange={setNote}
          placeholder="e.g. shared number — genuine customer vouched for by vendor"
          autoCapitalize="sentences"
          multiline
          numberOfLines={2}
        />

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Button variant="secondary" onPress={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onPress={submit} disabled={submitting} style={{ flex: 1 }}>
            {submitting ? 'Removing…' : 'Remove from blacklist'}
          </Button>
        </View>
      </View>
    </Sheet>
  );
}
