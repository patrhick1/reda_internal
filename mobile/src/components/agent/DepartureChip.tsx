import { Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import { formatTimeLagos } from '@/lib/date';

/** Status pill for a rider's "left the warehouse" state. Renders a green
 *  "On the road · <time>" pill when the agent has left today, and nothing when
 *  they're still at the warehouse — so the actionable state stands out and
 *  present agents don't add row noise. Shared by the ops agent lists (available
 *  orders, rep dashboard) so the indicator looks the same everywhere. */
export function DepartureChip({
  departedAt,
  size = 'md',
}: {
  departedAt: string | null | undefined;
  size?: 'sm' | 'md';
}) {
  if (!departedAt) return null;
  const sm = size === 'sm';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        alignSelf: 'flex-start',
        backgroundColor: colors.successSoft,
        paddingHorizontal: sm ? 8 : 10,
        paddingVertical: sm ? 2 : 4,
        borderRadius: 999,
      }}
    >
      <View
        style={{
          width: sm ? 5 : 6,
          height: sm ? 5 : 6,
          borderRadius: 999,
          backgroundColor: colors.success,
        }}
      />
      <Text
        style={{
          color: colors.successDark,
          fontFamily: fonts.semibold,
          fontSize: sm ? 10 : 11,
          lineHeight: sm ? 14 : 16,
        }}
      >
        On the road · {formatTimeLagos(departedAt)}
      </Text>
    </View>
  );
}
