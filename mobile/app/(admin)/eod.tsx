import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useCurrentUser } from '@/hooks/useAuth';
import { AppBar, Banner, Button, Card, Empty, StatusPill } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { todayLagos } from '@/lib/date';
import { formatNaira, formatYmdShort } from '@/lib/format';
import { errorMessage } from '@/lib/errors';
import { invalidateDeliveries } from '@/services/deliveries';
import {
  manualPreviewPage,
  manualEodStatus,
  prepareMaintenance,
  requestMaintenance,
  type ManualEodResult,
  type MaintenancePreview,
} from '@/services/maintenance';

const CLOSE_LABEL: Record<string, string> = {
  close_followup: 'Return to client',
  close_disinterest: 'Close as Unserious',
  close_policy: 'Close as Failed delivery',
  cap_unserious: 'Close as Unserious — carry limit reached',
  dedup_same_agent: 'Close duplicate',
  dedup_cross_agent: 'Close duplicate',
  dedup_postponed: 'Close duplicate',
  sibling_resolved: 'Close duplicate — already handled',
};
const movesForward = (action: string) => action === 'roll' || action === 'release';

export default function EndOfDay() {
  const router = useRouter();
  const user = useCurrentUser();
  const storageKey = `reda-eod-request:${user.userId}`;
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [result, setResult] = useState<ManualEodResult | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const saved = await AsyncStorage.getItem(storageKey);
      if (saved) {
        // Recover an interrupted response using the original idempotent request.
        await requestMaintenance(saved, 'finish_day');
        if (mounted.current) setProcessingId(saved);
      } else {
        const next = await prepareMaintenance('finish_day', todayLagos());
        if (mounted.current) {
          setPreview(next);
          setResult(null);
        }
      }
    } catch (e) {
      if (mounted.current) setError(errorMessage(e));
      if (['22023', '55000'].includes((e as { code?: string })?.code ?? ''))
        await AsyncStorage.removeItem(storageKey);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [storageKey]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!processingId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const next = await manualEodStatus(processingId!);
        if (cancelled) return;
        setError(null);
        if (next.complete) {
          await AsyncStorage.removeItem(storageKey);
          if (cancelled) return;
          setResult(next);
          setProcessingId(null);
          setPreview(null);
          invalidateDeliveries();
          return;
        }
      } catch {
        if (cancelled) return;
        setError(
          'Waiting for a connection to confirm the result. You do not need to run it again.',
        );
      }
      if (!cancelled) timer = setTimeout(() => void check(), 3000);
    }
    void check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [processingId, storageKey]);

  async function run() {
    if (!preview || submitting.current) return;
    submitting.current = true;
    setStarting(true);
    setError(null);
    try {
      await AsyncStorage.setItem(storageKey, preview.preview_id);
      await requestMaintenance(preview.preview_id, 'finish_day');
      setProcessingId(preview.preview_id);
    } catch (e) {
      setError(errorMessage(e));
      if (['22023', '55000'].includes((e as { code?: string })?.code ?? ''))
        await AsyncStorage.removeItem(storageKey);
    } finally {
      submitting.current = false;
      setStarting(false);
    }
  }
  const summary = preview?.summary ?? {};
  const forwardCount = (summary.roll ?? 0) + (summary.release ?? 0);
  const closeCount = (preview?.total_orders ?? 0) - forwardCount;
  const target = preview?.target_date ? formatYmdShort(preview.target_date) : '';
  const prepared = (result?.outcomes.rolled ?? 0) + (result?.outcomes.released ?? 0);
  const closed = Object.entries(result?.outcomes ?? {}).reduce(
    (total, [action, n]) => total + (['rolled', 'released', 'unchanged'].includes(action) ? 0 : n),
    0,
  );
  const working = starting || processingId != null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="End of day"
        subtitle="Decide what to do with unfinished deliveries"
        onBack={() => router.back()}
        helpTopic="eod"
      />
      {loading ? (
        <ActivityIndicator style={{ margin: 40 }} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 32 }}>
          {error ? <Banner tone="error">{error}</Banner> : null}
          {error && !working ? (
            <Button variant="secondary" onPress={() => void load()}>
              Refresh orders
            </Button>
          ) : null}
          {working ? (
            <Card style={{ gap: 12 }}>
              <ActivityIndicator />
              <Text style={{ fontFamily: fonts.bold }}>Working…</Text>
              <Text>
                Preparing the next working day. Please wait before assigning these orders.
              </Text>
            </Card>
          ) : result ? (
            <>
              <Banner tone={result.needs_attention ? 'warn' : 'ok'}>
                <Text>
                  {result.needs_attention
                    ? 'Some orders still need attention.'
                    : 'End of day complete.'}{' '}
                  {prepared} ready for {formatYmdShort(result.target_date)} · {closed} closed.
                </Text>
              </Banner>
              {result.problems.map((problem) => (
                <Card key={problem.id} style={{ gap: 8 }}>
                  <Text style={{ fontFamily: fonts.bold }}>{problem.customer_name}</Text>
                  <Text>{problem.message}</Text>
                  <Button
                    variant="secondary"
                    onPress={() => router.push(`/(admin)/deliveries/${problem.id}`)}
                  >
                    Open order
                  </Button>
                </Card>
              ))}
              {prepared > 0 ? (
                <Button
                  onPress={() =>
                    router.push({
                      pathname: '/(admin)/deliveries',
                      params: { filter: 'unassigned', preparedDate: result.target_date },
                    })
                  }
                >
                  View prepared orders
                </Button>
              ) : null}
              {result.needs_attention ? (
                <Button variant="secondary" onPress={() => void load()}>
                  Check remaining orders
                </Button>
              ) : null}
            </>
          ) : preview ? (
            <>
              {preview.total_orders === 0 ? (
                <Empty
                  icon="check"
                  title="No deliveries to roll"
                  sub="There are no unfinished orders to carry forward or close."
                />
              ) : (
                <>
                  <Banner tone="info" icon="calendar">
                    <Text>
                      {forwardCount} to roll forward to {target} · {closeCount} to close out.
                    </Text>
                  </Banner>
                  {[true, false].map((forward) => {
                    const count = forward ? forwardCount : closeCount;
                    if (!count) return null;
                    return (
                      <View key={String(forward)} style={{ gap: 10 }}>
                        <Text style={{ fontFamily: fonts.extrabold, fontSize: 18 }}>
                          {forward ? 'Roll forward' : 'Close out'} · {count}
                        </Text>
                        <Text>
                          {forward
                            ? `Ready for ${target}`
                            : 'These orders will close instead of moving forward.'}
                        </Text>
                        {preview.rows
                          .filter((row) => movesForward(row.action) === forward)
                          .map((row) => (
                            <Card key={row.id}>
                              <Text style={{ fontFamily: fonts.bold, fontSize: 15 }}>
                                {row.customer_name}
                              </Text>
                              {row.product_name ? (
                                <Text style={{ marginTop: 4 }}>
                                  {row.product_name}
                                  {row.quantity ? ` × ${row.quantity}` : ''} ·{' '}
                                  {formatNaira(row.customer_price)}
                                </Text>
                              ) : null}
                              <View
                                style={{
                                  flexDirection: 'row',
                                  flexWrap: 'wrap',
                                  alignItems: 'center',
                                  gap: 6,
                                  marginTop: 8,
                                }}
                              >
                                <StatusPill status={row.status} variant="subtle" size="sm" />
                                <Text>{row.agent ?? 'Unassigned'}</Text>
                              </View>
                              {!forward ? (
                                <Text style={{ marginTop: 8, color: colors.red }}>
                                  {CLOSE_LABEL[row.action] ?? 'Close order'}
                                </Text>
                              ) : null}
                            </Card>
                          ))}
                      </View>
                    );
                  })}
                  {preview.rows.length < preview.total_orders ? (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onPress={async () => {
                        setBusy(true);
                        try {
                          const more = await manualPreviewPage(
                            preview.preview_id,
                            preview.rows.length,
                          );
                          setPreview({ ...preview, rows: [...preview.rows, ...more] });
                        } catch (e) {
                          setError(errorMessage(e));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Show more orders
                    </Button>
                  ) : null}
                  {preview.oversized_groups > 0 ? (
                    <Banner tone="warn">
                      A group is too large to finish together. Please contact support before running
                      end of day.
                    </Banner>
                  ) : null}
                  <Button
                    variant="emphasis"
                    full
                    icon="check"
                    disabled={busy || preview.oversized_groups > 0}
                    onPress={() => {
                      const message = `Run end of day?\n\n${forwardCount} orders will move to ${target} (${preview.target_date}). ${closeCount} will close out. This includes all ${preview.total_orders} orders, including those on further pages.`;
                      if (Platform.OS === 'web') {
                        if (window.confirm(message)) void run();
                      } else
                        Alert.alert('Run end of day?', message, [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Run end of day', onPress: () => void run() },
                        ]);
                    }}
                  >
                    Run end of day
                  </Button>
                </>
              )}
            </>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
