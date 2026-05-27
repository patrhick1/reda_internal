import React, { useState } from 'react';
import type { TextInputProps } from 'react-native';
import { Text, TextInput, View } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import type { IconName } from './Icon';
import { Icon } from './Icon';

export type InputProps = Omit<TextInputProps, 'onChange' | 'onChangeText'> & {
  label?: string;
  value: string;
  onChange?: (v: string) => void;
  icon?: IconName;
  error?: string | null;
  helper?: string;
  focused?: boolean;
  rightAdornment?: React.ReactNode;
};

export function Input({
  label,
  value,
  onChange,
  placeholder,
  secureTextEntry,
  icon,
  error,
  helper,
  focused,
  rightAdornment,
  keyboardType,
  autoCapitalize,
  autoCorrect,
  multiline,
  numberOfLines,
  ...rest
}: InputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const showAccent = focused ?? isFocused;
  const borderColor = error ? colors.red : showAccent ? colors.red : colors.border;
  const borderWidth = error || showAccent ? 2 : 1;
  // Multiline wants the icon to sit at the top and the field to start tall
  // enough that the user sees they're in a textarea, not a single-line input.
  const rows = numberOfLines ?? (multiline ? 4 : 1);
  const minHeight = multiline ? Math.max(80, rows * 20) : undefined;

  return (
    <View>
      {label ? (
        <Text
          style={{
            fontFamily: fonts.semibold,
            fontSize: 12,
            color: colors.textSecondary,
            marginBottom: 6,
          }}
        >
          {label}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: multiline ? 'flex-start' : 'center',
          gap: 8,
          borderBottomWidth: borderWidth,
          borderBottomColor: borderColor,
          paddingBottom: 8 - (borderWidth - 1),
        }}
      >
        {icon ? (
          <View style={multiline ? { paddingTop: 8 } : undefined}>
            <Icon name={icon} size={18} color={colors.textSecondary} />
          </View>
        ) : null}
        <TextInput
          {...rest}
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          multiline={multiline}
          numberOfLines={multiline ? rows : undefined}
          textAlignVertical={multiline ? 'top' : undefined}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          style={{
            flex: 1,
            fontFamily: fonts.medium,
            fontSize: 15,
            color: colors.black,
            paddingVertical: 4,
            minHeight,
          }}
        />
        {rightAdornment}
      </View>
      {error || helper ? (
        <Text
          style={{
            marginTop: 6,
            fontFamily: fonts.medium,
            fontSize: 12,
            color: error ? colors.red : colors.textSecondary,
          }}
        >
          {error ?? helper}
        </Text>
      ) : null}
    </View>
  );
}
