import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { colors } from '@/lib/theme';
import { formatDateLagos, isYmd } from '@/lib/date';
import { CalendarPicker } from './CalendarPicker';
import { Icon } from './Icon';
import { Input } from './Input';
import { Sheet } from './Sheet';

/** A date text field with an opt-in calendar picker. The user can still type a
 *  `YYYY-MM-DD` by hand (unchanged behaviour) OR tap the calendar icon to pick a
 *  day from a month grid. The grid opens in a bottom Sheet rather than inline, so
 *  the field works in tight two-column rows (reconcile From/To) as well as
 *  full-width forms without the calendar getting squeezed.
 *
 *  By default the calendar reaches any past OR future day (reconcile ranges,
 *  scheduled dates, analytics). Pass `minExclusiveYmd` for a future-only field
 *  (postpone uses CalendarPicker directly for that today). */
export function DateField({
  label,
  value,
  onChange,
  minExclusiveYmd,
  disableSundays = false,
  placeholder = 'YYYY-MM-DD',
  sheetTitle,
}: {
  label?: string;
  value: string;
  onChange: (ymd: string) => void;
  minExclusiveYmd?: string;
  disableSundays?: boolean;
  placeholder?: string;
  /** Title for the picker sheet; defaults to "Pick <label>". */
  sheetTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Input
        label={label}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        rightAdornment={
          <Pressable
            onPress={() => setOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Open calendar"
          >
            <Icon name="calendar" size={18} color={colors.textSecondary} />
          </Pressable>
        }
      />
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={sheetTitle ?? (label ? `Pick ${label.toLowerCase()}` : 'Pick a date')}
        subtitle={isYmd(value) ? formatDateLagos(value) : undefined}
      >
        <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
          <CalendarPicker
            value={isYmd(value) ? value : null}
            onSelect={(ymd) => {
              onChange(ymd);
              setOpen(false);
            }}
            minExclusiveYmd={minExclusiveYmd}
            disableSundays={disableSundays}
          />
        </View>
      </Sheet>
    </>
  );
}
