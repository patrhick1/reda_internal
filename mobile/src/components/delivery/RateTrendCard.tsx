import { View, Text } from 'react-native';
import { Card, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { dayRatePct, weekdayShort, pooledRatePct, type RateDay } from '@/lib/rate-trend';

const TRACK_H = 60;

/** Home "Delivery rate" strip: last N days as bars, today drawn hollow to signal
 *  it's still in progress ("so far"). Tap → full history. Data comes from
 *  getDeliveryRateHistory; the parent passes the window and today's ISO date. */
export function RateTrendCard({
  days,
  today,
  loading,
  onPress,
}: {
  days: RateDay[];
  today: string;
  loading: boolean;
  onPress: () => void;
}) {
  // Settled days only (exclude today's partial) for the at-a-glance average.
  const settled = days.filter((d) => d.day !== today);
  const avg = pooledRatePct(settled).pct;

  return (
    <Card onPress={onPress} style={{ backgroundColor: colors.black, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <Text style={kicker}>Delivery rate</Text>
          <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textTertiary }}>
            {settled.length > 0 ? `${settled.length}-day avg ${avg ?? '—'}%` : 'Last 7 days'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.textTertiary }}>
            History
          </Text>
          <Icon name="chevronRight" size={16} color={colors.textTertiary} />
        </View>
      </View>

      <View style={{ marginTop: 16, flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
        {loading && days.length === 0
          ? Array.from({ length: 7 }).map((_, i) => <BarSkeleton key={i} />)
          : days.map((d) => <Bar key={d.day} day={d} isToday={d.day === today} />)}
        {!loading && days.length === 0 ? (
          <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textTertiary }}>
            No delivery activity yet.
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

function Bar({ day, isToday }: { day: RateDay; isToday: boolean }) {
  const pct = dayRatePct(day);
  const fillH = pct == null ? 0 : Math.max(3, Math.round((pct / 100) * TRACK_H));
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 6 }}>
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 11,
          color: pct == null ? colors.textTertiary : colors.white,
        }}
      >
        {pct == null ? '—' : `${pct}%`}
      </Text>
      <View
        style={{
          width: '78%',
          height: TRACK_H,
          justifyContent: 'flex-end',
          backgroundColor: '#1E1E1E',
          borderRadius: 5,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            height: fillH,
            borderRadius: 5,
            // Today drawn hollow (outlined) since the number is still climbing.
            backgroundColor: isToday ? 'transparent' : colors.success,
            borderWidth: isToday ? 1.5 : 0,
            borderColor: colors.success,
          }}
        />
      </View>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 10, color: colors.textTertiary }}>
        {isToday ? 'today' : weekdayShort(day.day)}
      </Text>
    </View>
  );
}

function BarSkeleton() {
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 6 }}>
      <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: 'transparent' }}>0%</Text>
      <View
        style={{ width: '78%', height: TRACK_H, backgroundColor: '#1E1E1E', borderRadius: 5 }}
      />
      <Text style={{ fontFamily: fonts.semibold, fontSize: 10, color: 'transparent' }}>—</Text>
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
