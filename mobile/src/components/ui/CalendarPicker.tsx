import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { colors, fonts, radii } from '@/lib/theme';
import { Icon } from './Icon';

/** A self-contained month-grid calendar — zero native deps, identical on web
 *  and Android. Selecting a day calls `onSelect` with a `YYYY-MM-DD` string.
 *
 *  Dates on or before `minExclusiveYmd` are disabled (the caller passes
 *  "today", so only future dates are pickable). Sundays are disabled by
 *  default because they're non-workdays the backend auto-bumps to Monday —
 *  blocking them up front avoids a surprise shift after submit. */
export function CalendarPicker({
  value,
  onSelect,
  minExclusiveYmd,
  disableSundays = true,
}: {
  value: string | null;
  onSelect: (ymd: string) => void;
  /** Dates <= this YYYY-MM-DD are not selectable. */
  minExclusiveYmd: string;
  disableSundays?: boolean;
}) {
  // The month currently on screen, as {y, m} (m is 1-12). Start on the
  // selected date's month, else the min date's month.
  const initial = parseYmd(value ?? minExclusiveYmd);
  const [view, setView] = useState<{ y: number; m: number }>({ y: initial.y, m: initial.m });

  const min = parseYmd(minExclusiveYmd);
  // Don't let the user page back into months that are entirely in the past.
  const atOrBeforeMinMonth = view.y < min.y || (view.y === min.y && view.m <= min.m);

  const cells = useMemo(() => buildMonthCells(view.y, view.m), [view.y, view.m]);

  function shiftMonth(delta: number) {
    setView((cur) => {
      const next = new Date(Date.UTC(cur.y, cur.m - 1 + delta, 1));
      return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1 };
    });
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.lg,
        padding: 12,
        backgroundColor: colors.white,
        gap: 8,
      }}
    >
      {/* Month header with prev / next */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <NavButton
          disabled={atOrBeforeMinMonth}
          onPress={() => shiftMonth(-1)}
          icon="chevronLeft"
        />
        <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
          {MONTHS[view.m - 1]} {view.y}
        </Text>
        <NavButton onPress={() => shiftMonth(1)} icon="chevronRight" />
      </View>

      {/* Weekday header (Mon-first; Sunday last since it's closed) */}
      <View style={{ flexDirection: 'row' }}>
        {WEEKDAYS.map((d, i) => (
          <Text
            key={d + i}
            style={{
              flexBasis: COL_BASIS,
              textAlign: 'center',
              fontFamily: fonts.semibold,
              fontSize: 11,
              color: i === 6 ? colors.textTertiary : colors.textSecondary,
            }}
          >
            {d}
          </Text>
        ))}
      </View>

      {/* Day grid */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((cell, idx) => {
          if (cell === null) {
            return <View key={`blank-${idx}`} style={{ flexBasis: COL_BASIS, height: 40 }} />;
          }
          const isSunday = cell.weekday === 0;
          const disabled = cell.ymd <= minExclusiveYmd || (disableSundays && isSunday);
          const selected = value === cell.ymd;
          return (
            <View key={cell.ymd} style={{ flexBasis: COL_BASIS, height: 40, padding: 2 }}>
              <Pressable
                disabled={disabled}
                onPress={() => onSelect(cell.ymd)}
                style={({ pressed }) => [
                  {
                    flex: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radii.md,
                    backgroundColor: selected ? colors.black : 'transparent',
                  },
                  pressed && !selected && { backgroundColor: colors.surface },
                ]}
              >
                <Text
                  style={{
                    fontFamily: selected ? fonts.bold : fonts.medium,
                    fontSize: 13,
                    color: selected ? colors.white : disabled ? colors.textTertiary : colors.black,
                  }}
                >
                  {cell.day}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function NavButton({
  onPress,
  icon,
  disabled = false,
}: {
  onPress: () => void;
  icon: 'chevronLeft' | 'chevronRight';
  disabled?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        {
          width: 34,
          height: 34,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radii.md,
          opacity: disabled ? 0.3 : 1,
        },
        pressed && !disabled && { backgroundColor: colors.surface },
      ]}
    >
      <Icon name={icon} size={18} color={colors.black} />
    </Pressable>
  );
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
// Monday-first so Sunday (the closed day) sits at the end of each row.
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Width of one of the seven columns. NOT `${100 / 7}%`: that's
// 14.285714285714286%, and in Yoga's float32 layout 7×that sums to just over
// 100% of the row — so in the day grid (flexWrap: 'wrap') the 7th cell (Sunday)
// wraps onto the next line, leaving every week showing only Mon–Sat and shoving
// the dates into the wrong weekday columns. Rounding the basis down to 14.2857%
// (7×14.2857 = 99.9999%) keeps all seven on one row with a sub-pixel gap.
const COL_BASIS = '14.2857%';

type DayCell = { day: number; ymd: string; weekday: number };

/** Builds the cell array for a month: leading nulls to pad to the first
 *  Monday, then one cell per day. All math in UTC to dodge TZ/DST wobble. */
function buildMonthCells(year: number, month: number): (DayCell | null)[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay(); // 0=Sun..6=Sat
  const leadingBlanks = (firstWeekday + 6) % 7; // shift so Monday=0
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const cells: (DayCell | null)[] = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, month - 1, day));
    cells.push({
      day,
      ymd: `${year}-${pad2(month)}-${pad2(day)}`,
      weekday: d.getUTCDay(),
    });
  }
  return cells;
}

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const parts = ymd.split('-');
  return { y: Number(parts[0]), m: Number(parts[1]), d: Number(parts[2]) };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
