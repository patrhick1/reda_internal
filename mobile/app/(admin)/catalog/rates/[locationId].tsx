import { useState } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { useAsync } from '@/hooks/useAsync';
import { getLocation } from '@/services/locations';
import { listRateHistory, upsertRateCard, type RateHistory } from '@/services/rate-card';
import { formatDateTime, formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

export default function RateDetail() {
  const { locationId } = useLocalSearchParams<{ locationId: string }>();
  const location = useAsync(() => getLocation(locationId), [locationId]);
  const history = useAsync(() => listRateHistory(locationId), [locationId]);

  const [charged, setCharged] = useState('');
  const [agentPayment, setAgentPayment] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = (history.data ?? []).find((r) => r.effective_until === null) ?? null;
  const past = (history.data ?? []).filter((r) => r.effective_until !== null);

  async function handleSubmit() {
    setError(null);
    const c = Number(charged);
    const a = Number(agentPayment);
    if (!Number.isFinite(c) || c < 0) {
      setError('Charged must be a non-negative number');
      return;
    }
    if (!Number.isFinite(a) || a < 0) {
      setError('Agent payment must be a non-negative number');
      return;
    }
    setSubmitting(true);
    try {
      await upsertRateCard(locationId, c, a, reason.trim() || null);
      setCharged('');
      setAgentPayment('');
      setReason('');
      history.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (location.loading || history.loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if (location.error || !location.data) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{location.error ?? 'Location not found'}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.locName}>{location.data.name}</Text>

      <Section title="Current rate">
        {current ? (
          <View style={styles.currentBox}>
            <CurrentLine label="Charged" value={formatNaira(current.charged)} />
            <CurrentLine label="Agent payment" value={formatNaira(current.agent_payment)} />
            <CurrentLine
              label="Margin"
              value={formatNaira(Number(current.charged) - Number(current.agent_payment))}
              accent
            />
            <CurrentLine
              label="Effective since"
              value={formatDateTime(current.effective_from)}
              muted
            />
          </View>
        ) : (
          <Text style={styles.noRate}>No rate set for this location yet.</Text>
        )}
      </Section>

      <Section title={current ? 'Set new rate' : 'Set rate'}>
        <Field
          label="Charged (₦)"
          value={charged}
          onChangeText={setCharged}
          keyboardType="numeric"
          autoCapitalize="none"
          required
        />
        <Field
          label="Agent payment (₦)"
          value={agentPayment}
          onChangeText={setAgentPayment}
          keyboardType="numeric"
          autoCapitalize="none"
          required
        />
        <Field
          label="Reason"
          value={reason}
          onChangeText={setReason}
          placeholder="Why the change? (logged in audit trail)"
        />

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <Button title="Save rate" onPress={handleSubmit} loading={submitting} />
        <Text style={styles.helper}>
          Saving creates a new version. The previous rate is preserved so historical deliveries
          retain context.
        </Text>
      </Section>

      {past.length > 0 ? (
        <Section title="History">
          {past.map((row) => (
            <HistoryRow key={row.id} row={row} />
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function CurrentLine({
  label,
  value,
  accent,
  muted,
}: {
  label: string;
  value: string;
  accent?: boolean;
  muted?: boolean;
}) {
  return (
    <View style={styles.currentLine}>
      <Text style={[styles.currentLabel, muted && styles.muted]}>{label}</Text>
      <Text style={[styles.currentValue, accent && styles.accent, muted && styles.mutedValue]}>
        {value}
      </Text>
    </View>
  );
}

function HistoryRow({ row }: { row: RateHistory }) {
  return (
    <View style={styles.historyRow}>
      <View style={styles.historyTop}>
        <Text style={styles.histValue}>
          {formatNaira(row.charged)} / {formatNaira(row.agent_payment)}
        </Text>
        <Text style={styles.histMargin}>
          margin {formatNaira(Number(row.charged) - Number(row.agent_payment))}
        </Text>
      </View>
      <Text style={styles.histRange}>
        {formatDateTime(row.effective_from)} →{' '}
        {row.effective_until ? formatDateTime(row.effective_until) : 'now'}
      </Text>
      {row.created_by_name ? (
        <Text style={styles.histAuthor}>set by {row.created_by_name}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 48 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  locName: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 16 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#888',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  currentBox: {
    borderWidth: 1,
    borderColor: '#e5e5e5',
    borderRadius: 8,
    backgroundColor: '#fafafa',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  currentLine: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  currentLabel: { fontSize: 14, color: '#444' },
  currentValue: { fontSize: 15, color: '#111', fontWeight: '600' },
  accent: { color: '#0a7a3a' },
  muted: { color: '#888', fontWeight: '400' },
  mutedValue: { color: '#888', fontWeight: '400', fontSize: 13 },
  noRate: { color: '#888', fontStyle: 'italic', paddingVertical: 8 },
  helper: { fontSize: 12, color: '#888', textAlign: 'center', marginTop: 8, lineHeight: 16 },
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  historyRow: {
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
  },
  historyTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  histValue: { fontSize: 14, fontWeight: '600', color: '#111' },
  histMargin: { fontSize: 13, color: '#0a7a3a', fontWeight: '500' },
  histRange: { fontSize: 12, color: '#666' },
  histAuthor: { fontSize: 12, color: '#888', marginTop: 2 },
});
