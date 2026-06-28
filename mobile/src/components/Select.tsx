import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts } from '@/lib/theme';
import { Icon } from '@/components/ui/Icon';

export type SelectOption<T extends string> = {
  value: T;
  label: string;
  sub?: string;
};

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  required,
  disabled,
  searchable = false,
  searchPlaceholder = 'Search…',
}: {
  label: string;
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  /** When true, shows a filter box in the sheet that matches both label and
   *  sub (so e.g. a product's client name is searchable). Default off — every
   *  existing Select is unchanged. */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  const selected = options.find((o) => o.value === value);

  // Focus the search box once the sheet is open. Done via ref + a tick rather
  // than autoFocus so it doesn't race the modal's fade-in animation (which can
  // drop focus / flicker the keyboard on some Android devices).
  useEffect(() => {
    if (!open || !searchable) return;
    const t = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open, searchable]);

  const needle = query.trim().toLowerCase();
  const visibleOptions = useMemo(
    () =>
      searchable && needle
        ? options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(needle))
        : options,
    [searchable, needle, options],
  );

  function close() {
    setOpen(false);
    setQuery('');
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.input,
          disabled && styles.inputDisabled,
          pressed && { opacity: 0.92 },
        ]}
      >
        <Text style={selected ? styles.inputText : styles.placeholder}>
          {selected ? selected.label : placeholder}
        </Text>
        <Icon name="chevronDown" size={18} color={colors.textSecondary} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={close}>
          <Pressable
            style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}
            onPress={() => undefined}
          >
            <View style={{ alignItems: 'center', paddingTop: 8 }}>
              <View
                style={{ width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2 }}
              />
            </View>
            <Text style={styles.sheetTitle}>{label}</Text>
            {searchable ? (
              <View style={styles.searchWrap}>
                <Icon name="search" size={16} color={colors.textSecondary} />
                <TextInput
                  ref={searchRef}
                  style={styles.searchInput}
                  value={query}
                  onChangeText={setQuery}
                  placeholder={searchPlaceholder}
                  placeholderTextColor={colors.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel={`Search ${label}`}
                />
                {query ? (
                  <Pressable
                    onPress={() => setQuery('')}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Clear search"
                  >
                    <Icon name="x" size={16} color={colors.textSecondary} />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            <FlatList
              data={visibleOptions}
              keyboardShouldPersistTaps="handled"
              keyExtractor={(o) => o.value}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [
                    styles.option,
                    item.value === value && styles.optionActive,
                    pressed && { opacity: 0.88 },
                  ]}
                  onPress={() => {
                    onChange(item.value);
                    close();
                  }}
                >
                  <View style={styles.optionLeft}>
                    <Text style={styles.optionLabel}>{item.label}</Text>
                    {item.sub ? <Text style={styles.optionSub}>{item.sub}</Text> : null}
                  </View>
                  {item.value === value ? (
                    <Icon name="check" size={18} color={colors.black} />
                  ) : null}
                </Pressable>
              )}
              ItemSeparatorComponent={() => <View style={styles.sep} />}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Text style={styles.emptyText}>{needle ? 'No matches.' : 'No options.'}</Text>
                </View>
              }
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  label: { fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary, marginBottom: 6 },
  required: { color: colors.red },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    backgroundColor: colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  inputDisabled: { opacity: 0.5 },
  inputText: { fontFamily: fonts.medium, color: colors.black, fontSize: 15 },
  placeholder: { fontFamily: fonts.medium, color: colors.textTertiary, fontSize: 15 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(10,10,10,0.42)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
  },
  sheetTitle: {
    fontFamily: fonts.bold,
    fontSize: 13,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 8,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: colors.surface,
  },
  searchInput: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 15,
    color: colors.black,
    padding: 0,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  optionActive: { backgroundColor: colors.surface },
  optionLeft: { flex: 1 },
  optionLabel: { fontFamily: fonts.semibold, fontSize: 15, color: colors.black },
  optionSub: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  sep: { height: 1, backgroundColor: colors.border },
  empty: { padding: 24, alignItems: 'center' },
  emptyText: { fontFamily: fonts.medium, color: colors.textSecondary },
});
