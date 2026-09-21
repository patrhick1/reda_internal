import { useEffect, useState } from 'react';
import { Alert, Platform, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { AppBar, Banner, Button, Card, Input } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import {
  maintenanceHealth,
  prepareMaintenance,
  requestMaintenance,
  retryMaintenanceGroup,
  resolveMaintenanceHold,
  type MaintenanceKind,
  type MaintenancePreview,
} from '@/services/maintenance';

const labels: Record<string, string> = {
  release: 'Release to Unassigned',
  dedup_postponed: 'Close duplicate postponement',
  roll: 'Carry to the next eligible workday',
  close_followup: 'Return to client',
  close_disinterest: 'Close as Unserious',
  close_policy: 'Close as Failed delivery',
  cap_unserious: 'Close as Unserious (carry limit)',
  dedup_same_agent: 'Close duplicate',
  dedup_cross_agent: 'Close duplicate',
  sibling_resolved: 'Close already-handled duplicate',
};
function confirmAction(message: string, action: () => void) {
  if (Platform.OS === 'web') {
    if (window.confirm(message)) action();
  } else
    Alert.alert('Confirm operation', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Continue', onPress: action },
    ]);
}
export default function EndOfDay() {
  const router = useRouter();
  const health = useAsync(maintenanceHealth, []);
  const [kind, setKind] = useState<MaintenanceKind>('release');
  const [date, setDate] = useState('');
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  useReloadOnFocus(health.reload);
  const reload = health.reload;
  useEffect(() => {
    const timer = setInterval(reload, 30000);
    return () => clearInterval(timer);
  }, [reload]);
  const selectedDate =
    date || (kind === 'release' ? health.data?.release_through : health.data?.close_through) || '';
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      health.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function openOrder(id: string) {
    router.push({ pathname: '/(admin)/deliveries/[id]', params: { id } });
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="End of day"
        subtitle="Processing health and safe recovery"
        onBack={() => router.back()}
        helpTopic="eod"
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 80 }}>
        {error || health.error ? (
          <Banner tone="error" icon="alert">
            {error ?? health.error}
          </Banner>
        ) : null}
        {message ? (
          <Banner tone="info" icon="check">
            {message}
          </Banner>
        ) : null}
        {!health.data ? (
          <Text>Loading processing status…</Text>
        ) : (
          <>
            <Card>
              <Text style={{ fontFamily: fonts.bold, fontSize: 18 }}>
                Automatic processing {health.data.enabled ? 'enabled' : 'paused'}
              </Text>
              <Text>
                Last worker check:{' '}
                {health.data.worker_at
                  ? new Date(health.data.worker_at).toLocaleString()
                  : 'No check recorded'}
              </Text>
              <Text>Today in Lagos: {health.data.today}. Today closes at 23:59 Lagos.</Text>
              <Text>
                Nightly work is checked again each morning. Queued work is processed in batches.
              </Text>
              {health.data.notification_failures > 0 ? (
                <Text>
                  {health.data.notification_failures} notification deliveries failed; order
                  processing is tracked separately.
                </Text>
              ) : null}
            </Card>
            {health.data.alerts.map((a) => (
              <Banner key={a.key} tone="warn" icon="alert">
                {a.message}
              </Banner>
            ))}
            <Card>
              <Text style={{ fontFamily: fonts.bold, fontSize: 18 }}>Choose an operation</Text>
              <View style={{ gap: 8, marginVertical: 12 }}>
                <Button
                  title={
                    kind === 'release' ? '✓ Release due postponements' : 'Release due postponements'
                  }
                  disabled={busy}
                  onPress={() => {
                    setKind('release');
                    setDate('');
                    setPreview(null);
                  }}
                />
                <Button
                  title={kind === 'close' ? '✓ Close a completed day' : 'Close a completed day'}
                  disabled={busy}
                  onPress={() => {
                    setKind('close');
                    setDate('');
                    setPreview(null);
                  }}
                />
              </View>
              <Text>
                {kind === 'release'
                  ? 'Release ordinary deliveries to Unassigned. Client-policy closures and duplicate handling appear in the preview. This does not close today’s active work.'
                  : 'Apply the existing carry limits and closure rules to this completed business day. Missed days carry directly to an actionable workday.'}
              </Text>
              <Input
                label={
                  kind === 'release'
                    ? 'Due on or before (YYYY-MM-DD)'
                    : 'Business day to close (YYYY-MM-DD)'
                }
                value={selectedDate}
                onChange={(value) => {
                  setDate(value);
                  setPreview(null);
                }}
              />
              <Button
                title="Preview exact scope"
                disabled={busy || !selectedDate}
                onPress={() =>
                  void perform(async () => {
                    setPreview(await prepareMaintenance(kind, selectedDate));
                    setMessage(null);
                  })
                }
              />
            </Card>
            {preview ? (
              <Card>
                <Text style={{ fontFamily: fonts.bold, fontSize: 18 }}>
                  {preview.rows.length} of {preview.total_orders} orders · {preview.kind} ·{' '}
                  {preview.date}
                </Text>
                {preview.total_orders > preview.rows.length ? (
                  <Text>
                    This preview contains complete groups up to 500 orders. After processing,
                    prepare another preview for the remainder. Automatic processing continues
                    through the full queue.
                  </Text>
                ) : null}
                {preview.oversized_groups > 0 ? (
                  <Text>
                    {preview.oversized_groups} unusually large groups need manual review before
                    processing.
                  </Text>
                ) : null}
                <Text>
                  Changes made after this preview are skipped and reported. Protected orders are
                  excluded. Carry counts are preserved on release.
                </Text>
                {preview.rows.map((row) => (
                  <View
                    key={row.id}
                    style={{
                      borderBottomWidth: 1,
                      borderBottomColor: colors.border,
                      paddingVertical: 10,
                      gap: 3,
                    }}
                  >
                    <Text style={{ fontFamily: fonts.bold }}>{row.customer_name}</Text>
                    <Text>
                      {row.status} · {row.date} · {row.agent ?? 'Unassigned'} · prior carries:{' '}
                      {row.carry}
                    </Text>
                    <Text>{labels[row.action] ?? row.action}</Text>
                    <Text onPress={() => openOrder(row.id)} style={{ color: colors.textSecondary }}>
                      Open order
                    </Text>
                  </View>
                ))}
                <Button
                  title={`Queue ${preview.rows.length} reviewed orders`}
                  disabled={busy || preview.rows.length === 0 || !health.data.enabled}
                  onPress={() =>
                    confirmAction(
                      `Queue ${preview.rows.length} orders for ${preview.kind} on ${preview.date}? Only this saved preview will be submitted.`,
                      () =>
                        void perform(async () => {
                          await requestMaintenance(preview.preview_id);
                          setPreview(null);
                          setMessage(
                            'Queued. Follow progress below; submission does not mean processing has finished.',
                          );
                        }),
                    )
                  }
                />
              </Card>
            ) : null}
            <Text style={{ fontFamily: fonts.bold, fontSize: 18 }}>Recent runs</Text>
            {health.data.runs.length === 0 ? (
              <Text>No processing runs recorded.</Text>
            ) : (
              health.data.runs.map((run) => (
                <Card key={run.id}>
                  <Text style={{ fontFamily: fonts.bold }}>
                    {run.business_date} · {run.kind} · {run.status}
                  </Text>
                  <Text>
                    {run.remaining_groups} groups remaining · {run.failed_groups} failed ·{' '}
                    {run.changed_groups} skipped after changes
                  </Text>
                  <Text>
                    {Object.entries(run.outcomes ?? {})
                      .map(([outcome, count]) => `${count} ${outcome.replaceAll('_', ' ')}`)
                      .join(' · ') || 'No order outcomes recorded'}
                  </Text>
                </Card>
              ))
            )}
            {health.data.failures.map((f) => (
              <Card key={f.id}>
                <Text style={{ fontFamily: fonts.bold }}>
                  Group {f.id}: {f.status}
                </Text>
                <Text>
                  {f.error_message ??
                    'Changed after preview. Review the current order before preparing another operation.'}
                </Text>
                {f.delivery_ids.map((id) => (
                  <Text key={id} onPress={() => openOrder(id)}>
                    Open {id}
                  </Text>
                ))}
                {f.status === 'failed' ? (
                  <Button
                    title="Retry after review"
                    disabled={busy}
                    onPress={() =>
                      void perform(async () => {
                        await retryMaintenanceGroup(f.id);
                        setMessage('Retry queued with the original scope and revision checks.');
                      })
                    }
                  />
                ) : null}
              </Card>
            ))}
            {health.data.holds.length > 0 ? (
              <>
                <Text style={{ fontFamily: fonts.bold, fontSize: 18 }}>
                  Protected orders awaiting review
                </Text>
                <Text>
                  These orders were excluded to preserve prior human handling. Removing protection
                  makes them eligible for a new preview or the next scheduled check.
                </Text>
                <Input
                  label="Review note (required before removing protection)"
                  value={reviewNote}
                  onChange={setReviewNote}
                />
                {health.data.holds.map((h) => (
                  <Card key={h.id}>
                    <Text style={{ fontFamily: fonts.bold }} onPress={() => openOrder(h.id)}>
                      {h.customer_name} · {h.date}
                    </Text>
                    <Text>{h.reason}</Text>
                    <Button
                      title="Remove protection after review"
                      disabled={busy || !reviewNote.trim()}
                      onPress={() =>
                        confirmAction(
                          'Make this order eligible for processing again?',
                          () =>
                            void perform(async () => {
                              await resolveMaintenanceHold(h.id, reviewNote.trim());
                              setMessage(
                                'Protection removed. Prepare a fresh preview to review the outcome.',
                              );
                            }),
                        )
                      }
                    />
                  </Card>
                ))}
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
