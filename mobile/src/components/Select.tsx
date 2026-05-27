import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
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
}: {
  label: string;
  value: T | null;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

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

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={{ alignItems: 'center', paddingTop: 8 }}>
              <View
                style={{ width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2 }}
              />
            </View>
            <Text style={styles.sheetTitle}>{label}</Text>
            <FlatList
              data={options}
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
                    setOpen(false);
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
                  <Text style={styles.emptyText}>No options.</Text>
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
    paddingBottom: 24,
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
