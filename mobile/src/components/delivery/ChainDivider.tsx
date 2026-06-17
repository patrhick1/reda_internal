import { Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import { formatDayMonthLagos } from '@/lib/date';

// Separates each delivery's block in a merged rollover-chain history timeline.
// The current delivery gets "This delivery"; earlier (carried-over) days get
// "Before rollover · <date>". Shared by the ops and agent detail screens.
export function ChainDivider({ isCurrent, date }: { isCurrent: boolean; date: string | null }) {
  const label = isCurrent
    ? 'This delivery'
    : `Before rollover${date ? ` · ${formatDayMonthLagos(date)}` : ''}`;
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 12 }}
    >
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 10,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
          color: colors.textTertiary,
        }}
      >
        {label}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
    </View>
  );
}
