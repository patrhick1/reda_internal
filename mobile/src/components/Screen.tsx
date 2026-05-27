import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import type { ReactNode } from 'react';
import { colors } from '@/lib/theme';

export function Screen({
  children,
  scroll = true,
  padded = true,
  style,
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: ViewStyle;
}) {
  const Wrapper = scroll ? ScrollView : View;
  const wrapperProps = scroll
    ? {
        contentContainerStyle: [padded && styles.padded, style],
        keyboardShouldPersistTaps: 'handled' as const,
      }
    : { style: [styles.flex, padded && styles.padded, style] };
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <Wrapper {...wrapperProps}>{children}</Wrapper>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.surface },
  padded: { padding: 16, backgroundColor: colors.surface },
});
