import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';
import {
  previewEodRollover,
  runEodRolloverAllStuck,
  type EodPreviewRow,
} from '@/services/reconciliation';
import { AppBar, Banner, Button, Card, Empty, StatusPill } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

import { todayLagos } from '@/lib/date';

// Presentation-only translation of the server's `action` code into a phrase for
// the close-out rows. NOT a rule — the DECISION (which rows roll vs close, and
// what they become) is made once, server-side, by _eod_classify and delivered
// via preview_eod_rollover. This map only labels it.
const ACTION_LABEL: Record<string, string> = {
  close_followup: 'Back to client',
  close_disinterest: 'Closed · unserious',
  close_policy: 'Closed · failed',
  cap_unserious: 'Closed · carry cap',
  dedup_same_agent: 'Closed · duplicate',
  dedup_cross_agent: 'Closed · duplicate',
  sibling_resolved: 'Closed · already handled',
};

export default function EndOfDay() {
  const router = useRouter();
  const [rolling, setRolling] = useState(false);
  const today = todayLagos();
  const previewQ = useAsync<EodPreviewRow[]>(() => previewEodRollover(today), [today]);
  useReloadOnFocus(() => {
    previewQ.reload();
  });

  // Split by the server's verdict: only 'roll' carries forward; everything else
  // is closed out. No status logic on the device — `action` comes straight from
  // the same classifier the nightly job runs.
  const { willRoll, willClose } = useMemo(() => {
    const roll: EodPreviewRow[] = [];
    const close: EodPreviewRow[] = [];
    for (const r of previewQ.data ?? []) {
      if (r.action === 'roll') roll.push(r);
      else close.push(r);
    }
    return { willRoll: roll, willClose: close };
  }, [previewQ.data]);

  const openCount = willRoll.length + willClose.length;

  const onRunAll = useCallback(() => {
    const prompt = `Run end of day?\n\nReleases postponed orders due tomorrow, carries the active orders forward, and closes out the rest — follow-ups go back to the client. ${willRoll.length} will roll forward and ${willClose.length} will be closed.`;
    const runIt = async () => {
      setRolling(true);
      try {
        const n = await runEodRolloverAllStuck();
        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined')
            window.alert(`Rolled ${n} ${n === 1 ? 'delivery' : 'deliveries'} forward.`);
        } else {
          Alert.alert('Done', `Rolled ${n} ${n === 1 ? 'delivery' : 'deliveries'} forward.`);
        }
        previewQ.reload();
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
      `Carries the active orders forward and closes out the rest (follow-ups go back to the client). ${willRoll.length} will roll forward and ${willClose.length} will be closed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Run end of day', style: 'destructive', onPress: runIt },
      ],
    );
  }, [willRoll.length, willClose.length, previewQ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="End of day"
        subtitle="Decide what to do with unfinished deliveries"
        onBack={() => router.back()}
        helpTopic="eod"
      />
      {previewQ.loading && !previewQ.data ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : previewQ.error ? (
        <Empty icon="alert" title="Could not load" sub={previewQ.error} />
      ) : openCount === 0 ? (
        <Empty
          icon="check"
          title="No deliveries to roll"
          sub="Everything closed out cleanly. Rest up."
        />
      ) : (
        <>
          <View style={{ padding: 16 }}>
            <Banner tone="info" icon="calendar">
              {`${openCount} still open for ${today}. End of day carries ${willRoll.length} forward and closes ${willClose.length} out — follow-ups go back to the client. Duplicates and repeat-rollovers are closed automatically.`}
            </Banner>
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 16, paddingTop: 0, paddingBottom: 100, gap: 12 }}
          >
            {willRoll.length > 0 ? (
              <>
                <SectionHeader
                  label="Roll forward"
                  count={willRoll.length}
                  sub="Carried to tomorrow as new pending orders"
                />
                {willRoll.map((r) => (
                  <DeliveryRowEOD key={r.delivery_id} row={r} />
                ))}
              </>
            ) : null}
            {willClose.length > 0 ? (
              <>
                <SectionHeader
                  label="Close out"
                  count={willClose.length}
                  sub="Not rolled — closed out at end of day"
                />
                {willClose.map((r) => (
                  <DeliveryRowEOD
                    key={r.delivery_id}
                    row={r}
                    closeLabel={ACTION_LABEL[r.action] ?? 'Closed'}
                  />
                ))}
              </>
            ) : null}
          </ScrollView>
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              backgroundColor: colors.white,
            }}
          >
            <Button variant="emphasis" full icon="check" disabled={rolling} onPress={onRunAll}>
              {rolling ? 'Working…' : 'Run end of day'}
            </Button>
          </View>
        </>
      )}
    </View>
  );
}

function SectionHeader({ label, count, sub }: { label: string; count: number; sub: string }) {
  return (
    <View style={{ marginTop: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ fontFamily: fonts.extrabold, fontSize: 16, color: colors.black }}>
          {label}
        </Text>
        <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.textSecondary }}>
          {count}
        </Text>
      </View>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 12,
          color: colors.textSecondary,
          marginTop: 2,
        }}
      >
        {sub}
      </Text>
    </View>
  );
}

function DeliveryRowEOD({ row, closeLabel }: { row: EodPreviewRow; closeLabel?: string }) {
  // customer_price is per-delivery, not per-unit. Do NOT multiply by quantity.
  const expected = Number(row.customer_price ?? 0);
  return (
    <Card>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
            {row.customer_name}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {row.product_name ?? '—'}
            {row.quantity_ordered ? ` × ${row.quantity_ordered}` : ''}
            {' · '}
            {formatNaira(expected)}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <StatusPill status={row.current_status ?? 'pending'} variant="subtle" size="sm" />
            {row.assigned_agent_name ? (
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: fonts.medium,
                  fontSize: 12,
                  color: colors.textSecondary,
                  flexShrink: 1,
                }}
              >
                {/* Full display name so namesakes (e.g. "Mummy Jerry") stay distinguishable. */}·{' '}
                {row.assigned_agent_name}
              </Text>
            ) : (
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: 11,
                  color: colors.red,
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                }}
              >
                Unassigned
              </Text>
            )}
          </View>
          {closeLabel ? (
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 11,
                color: colors.textSecondary,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginTop: 6,
              }}
            >
              {`Ends as · ${closeLabel}`}
            </Text>
          ) : null}
        </View>
      </View>
    </Card>
  );
}
