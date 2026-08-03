import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';

/**
 * One counted product: what the app expected, what was physically counted, and
 * the signed difference.
 *
 * Lifted out of the count screen's results banner so the count-history feed can
 * render an old run identically to the way it looked the moment it was
 * recorded — the whole point of a history is that the number you see later is
 * the number you saw then.
 *
 * `MovementSummary` deliberately keeps its own variance colouring: it tints
 * label/value lines rather than rows, and needs a fourth "neutral" tone this
 * doesn't. Only `signedVariance` / `varianceColor` are worth sharing with it.
 */

/** "+3" / "-2" / "0" — leading sign only when positive, matching the count screen. */
export function signedVariance(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`;
}

/** Green over, red short, muted when it matches. */
export function varianceColor(n: number): string {
  if (n > 0) return colors.success;
  if (n < 0) return colors.red;
  return colors.textSecondary;
}

export function VarianceRow({
  productName,
  expected,
  counted,
  variance,
  divider,
}: {
  productName: string;
  expected: number;
  counted: number;
  variance: number;
  /** Top border, for every row after the first in a card. */
  divider?: boolean;
}) {
  return (
    <View style={[styles.row, divider && styles.divider]}>
      <View style={styles.grow}>
        <Text style={styles.name}>{productName}</Text>
        <Text style={styles.sub}>
          App {expected} · Counted {counted}
        </Text>
      </View>
      <Text style={[styles.variance, { color: varianceColor(variance) }]}>
        {variance === 0 ? '✓' : signedVariance(variance)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  grow: { flex: 1 },
  name: { fontFamily: fonts.semibold, fontSize: 15, color: colors.black },
  sub: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  variance: { fontFamily: fonts.extrabold, fontSize: 16 },
});
