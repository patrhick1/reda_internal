import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';

/**
 * Inline "confirm this destructive thing, and say why" panel.
 *
 * Replaces `Alert.prompt` on the catalog screens. Alert.prompt is iOS-only —
 * its entire RN implementation is wrapped in `if (Platform.OS === 'ios')`, so
 * on Android it returns having done nothing: no dialog, no error, and no
 * callback (which is why the old code's "Reason required" fallback never fired
 * either). The fleet runs Android, so every one of those buttons was dead.
 *
 * Rendering the prompt inline instead of as a modal means one code path for
 * every platform, and the reason stays visible while it is typed. Mirrors the
 * DeactivatePanel already used by the user catalog screen.
 */
export function ReasonPanel({
  title,
  blurb,
  confirmLabel,
  onConfirm,
  onCancel,
  submitting,
  confirmDisabled,
  children,
}: {
  title: string;
  /** Optional consequence line shown above the reason box. */
  blurb?: string;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
  submitting?: boolean;
  /** Hold the confirm button until the caller is satisfied — e.g. until the
   *  admin has acknowledged a list of blockers. */
  confirmDisabled?: boolean;
  /** Rendered between the blurb and the reason field. For detail the panel
   *  can't know about, like who is holding what. */
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const trimmed = reason.trim();

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{title}</Text>
      {blurb ? <Text style={styles.blurb}>{blurb}</Text> : null}
      {children}

      <Field
        label="Reason"
        required
        value={reason}
        onChangeText={setReason}
        placeholder="Why is this happening? Saved to the audit log."
        multiline
      />
      {touched && !trimmed ? <Text style={styles.error}>Reason required</Text> : null}

      <Button
        title={confirmLabel}
        variant="danger"
        loading={submitting}
        disabled={confirmDisabled}
        onPress={() => {
          setTouched(true);
          if (trimmed) onConfirm(trimmed);
        }}
      />
      <Button
        title="Cancel"
        variant="secondary"
        onPress={onCancel}
        disabled={submitting}
        style={styles.cancel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginTop: 24,
    padding: 14,
    borderWidth: 1,
    borderColor: '#f0c9c2',
    borderRadius: 8,
    backgroundColor: '#fdf6f5',
  },
  title: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 6 },
  blurb: { fontSize: 13, color: '#555', lineHeight: 19, marginBottom: 10 },
  error: { color: '#a02d1b', fontSize: 13, marginBottom: 10 },
  cancel: { marginTop: 10 },
});
