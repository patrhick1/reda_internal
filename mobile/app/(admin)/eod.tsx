import { useEffect, useRef, useState } from 'react';
import { Alert, Platform, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import { AppBar, Banner, Button, Card, Input } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import { invalidateDeliveries } from '@/services/deliveries';
import {
  maintenanceHealth,
  manualPreviewPage,
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
  const [kind, setKind] = useState<MaintenanceKind>('finish_day');
  const [recovery, setRecovery] = useState(false);
  const [date, setDate] = useState('');
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const refreshedRuns = useRef(new Set<string>());
  useEffect(() => {
    let changed = false;
    for (const run of health.data?.runs ?? []) {
      if (run.remaining_groups !== 0) continue;
      const revision = `${run.id}:${run.status}:${JSON.stringify(run.outcomes)}`;
      if (!refreshedRuns.current.has(revision)) {
        refreshedRuns.current.add(revision);
        changed = true;
      }
    }
    if (changed) invalidateDeliveries();
  }, [health.data?.runs]);
  useReloadOnFocus(health.reload);
  const reload = health.reload;
  useEffect(() => {
    const timer = setInterval(
      reload,
      health.data?.runs.some((run) => run.remaining_groups > 0) ? 3000 : 30000,
    );
    return () => clearInterval(timer);
  }, [reload, health.data?.runs]);
  const selectedDate =
    (kind === 'finish_day'
      ? health.data?.today
      : date || (kind === 'release' ? health.data?.release_through : health.data?.close_through)) ||
    '';
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
        subtitle="Finish today and prepare the next working day"
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
              <Text style={{ fontFamily: fonts.bold, fontSize: 18 }}>Finish today</Text>
              <Text>
                Finish when work is done, including around 10pm Lagos. The automatic 23:59 Lagos run
                is the fallback.
              </Text>
              <Text>
                Preview the destination date and outcomes, finish processing, then assign the
                prepared orders to agents.
              </Text>
              <Button
                title={recovery ? 'Hide recovery tools' : 'Recovery tools'}
                disabled={busy}
                onPress={() => {
                  setRecovery(!recovery);
                  setKind('finish_day');
                  setDate('');
                  setPreview(null);
                }}
              />
              {recovery ? (
                <View style={{ gap: 8, marginVertical: 12 }}>
                  {(['finish_day', 'release', 'close'] as const).map((option) => (
                    <Button
                      key={option}
                      title={`${kind === option ? '✓ ' : ''}${option === 'finish_day' ? 'Finish today' : option === 'release' ? 'Release due postponements' : 'Close a completed day'}`}
                      disabled={busy}
                      onPress={() => {
                        setKind(option);
                        setDate('');
                        setPreview(null);
                      }}
                    />
                  ))}
                  {kind !== 'finish_day' ? (
                    <>
                      <Text>
                        {kind === 'release'
                          ? 'Release postponements already due. To prepare the next working day early, choose Finish today.'
                          : 'Recover a completed day using the existing carry limits and closure rules.'}
                      </Text>
                      <Input
                        label={
                          kind === 'release'
                            ? 'Due on or before (YYYY-MM-DD)'
                            : 'Completed day (YYYY-MM-DD)'
                        }
                        value={selectedDate}
                        onChange={(value) => {
                          setDate(value);
                          setPreview(null);
                        }}
                      />
                    </>
                  ) : null}
                </View>
              ) : null}
              <Button
                title={kind === 'finish_day' ? 'Preview next working day' : 'Preview recovery'}
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
                  {preview.kind === 'finish_day'
                    ? `${preview.date} → ${preview.target_date}`
                    : `${preview.kind} · ${preview.date}`}
                </Text>
                <Text>
                  {preview.total_orders} orders in this saved review · {preview.rows.length} shown
                </Text>
                {preview.summary ? (
                  <Text>
                    {Object.entries(preview.summary)
                      .map(([action, count]) => `${count} ${labels[action] ?? action}`)
                      .join(' · ')}
                  </Text>
                ) : null}
                {preview.kind !== 'finish_day' && preview.total_orders > preview.rows.length ? (
                  <Text>
                    Recovery processes the displayed complete groups, up to 500 orders. Preview
                    again for the remainder.
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
                    <Text>
                      {labels[row.action] ?? row.action}
                      {row.target_date ? ` · ${row.date} → ${row.target_date}` : ''}
                    </Text>
                    <Text onPress={() => openOrder(row.id)} style={{ color: colors.textSecondary }}>
                      Open order
                    </Text>
                  </View>
                ))}
                {preview.kind === 'finish_day' && preview.rows.length < preview.total_orders ? (
                  <Button
                    title="Load more reviewed orders"
                    disabled={busy}
                    onPress={() =>
                      void perform(async () => {
                        const more = await manualPreviewPage(
                          preview.preview_id,
                          preview.rows.length,
                        );
                        setPreview({ ...preview, rows: [...preview.rows, ...more] });
                      })
                    }
                  />
                ) : null}
                <Button
                  title={
                    preview.kind === 'finish_day'
                      ? `Finish day · prepare ${preview.target_date}`
                      : `Queue ${preview.rows.length} reviewed orders`
                  }
                  disabled={busy || preview.total_orders === 0 || !health.data.enabled}
                  onPress={() =>
                    confirmAction(
                      preview.kind === 'finish_day'
                        ? `Finish ${preview.date} and prepare ${preview.target_date}? The saved review covers all ${preview.total_orders} orders, including those on further pages. Carry-limit and other closures shown above also apply. Wait for completion before assigning.`
                        : `Queue ${preview.rows.length} orders for ${preview.kind} on ${preview.date}?`,
                      () =>
                        void perform(async () => {
                          await requestMaintenance(preview.preview_id, preview.kind);
                          setPreview(null);
                          setMessage(
                            'Processing requested. Follow progress below and wait for completion before assigning prepared orders.',
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
                    {run.business_date}
                    {run.target_date ? ` → ${run.target_date}` : ''} ·{' '}
                    {run.kind === 'finish_day' ? 'Finish day' : run.kind} · {run.status}
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
                  {run.kind === 'finish_day' && run.target_date && run.remaining_groups === 0 ? (
                    <>
                      {run.failed_groups > 0 || run.changed_groups > 0 ? (
                        <Text>
                          Some groups need review. Only successfully prepared orders will appear.
                        </Text>
                      ) : null}
                      <Button
                        title="View prepared orders"
                        onPress={() =>
                          router.push({
                            pathname: '/(admin)/deliveries',
                            params: { filter: 'unassigned', preparedDate: run.target_date! },
                          })
                        }
                      />
                    </>
                  ) : null}
                </Card>
              ))
            )}
            <Card>
              <Text style={{ fontFamily: fonts.bold }}>
                Automatic processing {health.data.enabled ? 'enabled' : 'paused'}
              </Text>
              <Text>Today in Lagos: {health.data.today}. Automatic fallback: 23:59 Lagos.</Text>
              <Text>
                Last worker check:{' '}
                {health.data.worker_at
                  ? new Date(health.data.worker_at).toLocaleString()
                  : 'No check recorded'}
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
