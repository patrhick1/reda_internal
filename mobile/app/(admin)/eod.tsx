import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useCurrentUser } from '@/hooks/useAuth';
import { listDeliveries, type DeliveryRow } from '@/services/deliveries';
import { runEodRollover } from '@/services/reconciliation';
import { AppBar, Banner, Button, Card, Empty, StatusPill } from '@/components/ui';
import { colors, fonts, TERMINAL_STATUSES } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

import { todayLagos } from '@/lib/date';

export default function EndOfDay() {
  const user = useCurrentUser();
  const router = useRouter();
  const [rolling, setRolling] = useState(false);
  const todayQ = useAsync(() => listDeliveries(user.role), [user.role]);
  useFocusEffect(useCallback(() => {
    todayQ.reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

  const unfinished = useMemo(
    () => (todayQ.data ?? []).filter(d => !TERMINAL_STATUSES.has(d.current_status ?? 'pending')),
    [todayQ.data],
  );

  const today = todayLagos();

  const onRunAll = useCallback(() => {
    const prompt = `Run end-of-day rollover?\n\nThis rolls every non-terminal delivery scheduled for ${today} forward one day. ${unfinished.length} ${unfinished.length === 1 ? 'delivery' : 'deliveries'} will be affected.`;
    const runIt = async () => {
      setRolling(true);
      try {
        const n = await runEodRollover(today);
        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined') window.alert(`Rolled ${n} ${n === 1 ? 'delivery' : 'deliveries'} forward.`);
        } else {
          Alert.alert('Done', `Rolled ${n} ${n === 1 ? 'delivery' : 'deliveries'} forward.`);
        }
        todayQ.reload();
      } catch (e) {
        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined') window.alert(`Rollover failed: ${errorMessage(e)}`);
        } else {
          Alert.alert('Rollover failed', errorMessage(e));
        }
      } finally {
        setRolling(false);
      }
    };

    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm(prompt)) runIt();
      return;
    }
    Alert.alert(
      'Run end-of-day rollover?',
      `This rolls every non-terminal delivery scheduled for ${today} forward one day. ${unfinished.length} ${unfinished.length === 1 ? 'delivery' : 'deliveries'} will be affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Roll all forward', style: 'destructive', onPress: runIt },
      ],
    );
  }, [today, unfinished.length, todayQ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="End of day"
        subtitle="Decide what to do with unfinished deliveries"
        onBack={() => router.back()}
        helpTopic="eod"
      />
      {todayQ.loading && !todayQ.data ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : unfinished.length === 0 ? (
        <Empty icon="check" title="No deliveries to roll" sub="Everything closed out cleanly. Rest up." />
      ) : (
        <>
          <View style={{ padding: 16 }}>
            <Banner tone="info" icon="calendar">
              {`${unfinished.length} ${unfinished.length === 1 ? 'delivery' : 'deliveries'} still open. Rolling forward will mark each as rolled_over and create a new pending row for tomorrow.`}
            </Banner>
          </View>
          <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 100, gap: 12 }}>
            {unfinished.map(d => <DeliveryRowEOD key={d.id} delivery={d} />)}
          </ScrollView>
          <View style={{
            paddingHorizontal: 16, paddingVertical: 12,
            borderTopWidth: 1, borderTopColor: colors.border,
            backgroundColor: colors.white,
          }}>
            <Button
              variant="emphasis" full icon="check"
              disabled={rolling}
              onPress={onRunAll}
            >
              {rolling ? 'Rolling…' : `Roll ${unfinished.length} forward`}
            </Button>
          </View>
        </>
      )}
    </View>
  );
}

function DeliveryRowEOD({ delivery }: { delivery: DeliveryRow }) {
  // customer_price is per-delivery, not per-unit. Do NOT multiply by quantity.
  const expected = Number(delivery.customer_price ?? 0);
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
            {delivery.customer_name}
          </Text>
          <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
            {delivery.product_name ?? '—'}
            {delivery.quantity_ordered ? ` × ${delivery.quantity_ordered}` : ''}
            {' · '}{formatNaira(expected)}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <StatusPill status={delivery.current_status ?? 'pending'} variant="subtle" size="sm" />
            {delivery.assigned_agent_name ? (
              <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
                · {delivery.assigned_agent_name.split(/\s+/)[0]}
              </Text>
            ) : (
              <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: colors.red, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                Unassigned
              </Text>
            )}
          </View>
        </View>
      </View>
    </Card>
  );
}
