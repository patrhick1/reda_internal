import { View, Text } from 'react-native';
import { Card, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { dayRatePct, weekdayShort, pooledRatePct, rateColor, type RateDay } from '@/lib/rate-trend';

const TRACK_H = 60;

/** Home "Delivery rate" strip: the latest six working days as individual bars.
 *  Today is drawn hollow to signal it's still in progress. Tap → full history. Data comes from
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
  // The headline represents the same six-day window shown by the bars,
  // including today's live rate when today is present.
  const avg = pooledRatePct(days).pct;

  return (
    <Card onPress={onPress} style={{ backgroundColor: colors.black, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View>
          <Text style={kicker}>Delivery rate</Text>
          <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textTertiary }}>
            {days.length > 0 ? `6-day avg ${avg ?? '—'}%` : 'Last 6 working days'}
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
          ? Array.from({ length: 6 }).map((_, i) => <BarSkeleton key={i} />)
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
  // Banded colour (<50 red, 50-74 orange, 75-89 green, 90+ light green) so a
  // bad day stands out in the strip at a glance.
  const band = rateColor(pct, 'dark', colors.textTertiary);
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 6 }}>
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 11,
          color: pct == null ? colors.textTertiary : band,
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
            backgroundColor: isToday ? 'transparent' : band,
            borderWidth: isToday ? 1.5 : 0,
            borderColor: band,
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
