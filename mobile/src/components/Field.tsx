import { useState } from 'react';
import { StyleSheet, Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { colors, fonts } from '@/lib/theme';

/**
 * Legacy Field component, retained for older catalog forms.
 * Restyled with Reda design tokens. New screens should import `Input` from
 * `@/components/ui` instead.
 */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize = 'sentences',
  multiline,
  editable = true,
  required,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  multiline?: boolean;
  editable?: boolean;
  required?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      <TextInput
        style={[styles.input, multiline && styles.multiline, focused && styles.inputFocused]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        multiline={multiline}
        editable={editable}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
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
    paddingVertical: 12,
    fontFamily: fonts.medium,
    fontSize: 15,
    backgroundColor: colors.white,
    color: colors.black,
  },
  inputFocused: {
    borderColor: colors.red,
    borderWidth: 2,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
});
