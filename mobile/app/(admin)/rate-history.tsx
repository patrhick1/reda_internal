import { useMemo } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { getDeliveryRateHistory } from '@/services/reconciliation';
import { AppBar, Card, Empty } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { todayLagos } from '@/lib/date';
import {
  addDays,
  dayRatePct,
  monthDayLabel,
  pooledRatePct,
  weekdayShort,
  type RateDay,
} from '@/lib/rate-trend';

const CHART_H = 116;

export default function RateHistory() {
  const router = useRouter();
  const today = todayLagos();
  const q = useAsync<RateDay[]>(() => getDeliveryRateHistory(addDays(today, -29), today), [today]);

  const days = useMemo(() => q.data ?? [], [q.data]);
  const settled = useMemo(() => days.filter((d) => d.day !== today), [days, today]);
  const headline = useMemo(() => pooledRatePct(settled), [settled]);
  const best = useMemo(() => {
    let top: { pct: number; day: string } | null = null;
    for (const d of settled) {
      const pct = dayRatePct(d);
      if (pct != null && (top == null || pct > top.pct)) top = { pct, day: d.day };
    }
    return top;
  }, [settled]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Delivery rate"
        subtitle="Orders delivered of those that reached Available"
        onBack={() => router.back()}
      />
      {q.loading && !q.data ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      ) : q.error ? (
        <Empty icon="alert" title="Could not load" sub={q.error} />
      ) : settled.length === 0 ? (
        <Empty
          icon="calendar"
          title="No history yet"
          sub="Delivery rate will show here once orders have been worked."
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}>
          {/* Headline — the screenshot number. */}
          <Card style={{ backgroundColor: colors.black, padding: 20 }}>
            <Text style={kicker}>Avg delivery rate</Text>
            <Text
              style={{
                fontFamily: fonts.extrabold,
                fontSize: 56,
                color: colors.white,
                letterSpacing: -1.5,
                marginTop: 2,
              }}
            >
              {headline.pct ?? '—'}%
            </Text>
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textTertiary }}>
              {`Last ${settled.length} days · ${headline.delivered.toLocaleString()} of ${headline.available.toLocaleString()} available orders delivered`}
            </Text>
            <View style={{ flexDirection: 'row', gap: 20, marginTop: 16 }}>
              {best ? (
                <MiniStat label="Best day" value={`${best.pct}%`} sub={monthDayLabel(best.day)} />
              ) : null}
              <MiniStat label="Days tracked" value={String(settled.length)} sub="with orders" />
            </View>
          </Card>

          {/* Daily bars. */}
          <Card>
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
              Daily rate
            </Text>
            <View style={{ marginTop: 14, flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
              {days.map((d) => (
                <ChartBar key={d.day} day={d} isToday={d.day === today} />
              ))}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
              <Text style={axisLabel}>{days[0] ? monthDayLabel(days[0].day) : ''}</Text>
              <Text style={axisLabel}>
                {days[days.length - 1] ? monthDayLabel(days[days.length - 1]!.day) : ''}
              </Text>
            </View>
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 11,
                color: colors.textTertiary,
                marginTop: 6,
              }}
            >
              Hollow bar = today (still climbing).
            </Text>
          </Card>

          {/* Exact daily numbers — newest first. */}
          <Card>
            <Text
              style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black, marginBottom: 4 }}
            >
              By day
            </Text>
            {[...days].reverse().map((d, i) => (
              <DayRow key={d.day} day={d} isToday={d.day === today} striped={i % 2 === 1} />
            ))}
          </Card>
        </ScrollView>
      )}
    </View>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <View>
      <Text style={{ fontFamily: fonts.bold, fontSize: 18, color: colors.white }}>{value}</Text>
      <Text
        style={{
          fontFamily: fonts.semibold,
          fontSize: 10,
          color: colors.textTertiary,
          letterSpacing: 0.4,
          textTransform: 'uppercase',
          marginTop: 2,
        }}
      >
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textTertiary }}>
        {sub}
      </Text>
    </View>
  );
}

function ChartBar({ day, isToday }: { day: RateDay; isToday: boolean }) {
  const pct = dayRatePct(day);
  const fillH = pct == null ? 0 : Math.max(3, Math.round((pct / 100) * CHART_H));
  return (
    <View style={{ flex: 1, justifyContent: 'flex-end', height: CHART_H }}>
      <View
        style={{
          height: fillH,
          borderRadius: 3,
          backgroundColor: isToday ? 'transparent' : colors.success,
          borderWidth: isToday ? 1.5 : 0,
          borderColor: colors.success,
        }}
      />
    </View>
  );
}

function DayRow({ day, isToday, striped }: { day: RateDay; isToday: boolean; striped: boolean }) {
  const pct = dayRatePct(day);
  return (
    // Alternating row colours (Greg's ticket) so the eye traces date → counts →
    // % across the row without slipping a line. Stripes replace the old border
    // separators; negative margin lets the stripe bleed to the card edges.
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 10,
        paddingHorizontal: 12,
        marginHorizontal: -12,
        borderRadius: 8,
        backgroundColor: striped ? colors.surface : 'transparent',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.black, width: 62 }}>
          {monthDayLabel(day.day)}
        </Text>
        <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textTertiary }}>
          {weekdayShort(day.day)}
          {isToday ? ' · so far' : ''}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
          {day.delivered}/{day.available}
        </Text>
        <Text
          style={{
            fontFamily: fonts.extrabold,
            fontSize: 14,
            color: pct == null ? colors.textTertiary : colors.black,
            width: 44,
            textAlign: 'right',
          }}
        >
          {pct == null ? '—' : `${pct}%`}
        </Text>
      </View>
    </View>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textTertiary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};

const axisLabel = {
  fontFamily: fonts.medium,
  fontSize: 10,
  color: colors.textTertiary,
};
