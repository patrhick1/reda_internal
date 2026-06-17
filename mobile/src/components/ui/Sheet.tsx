import React, { useEffect, useRef } from 'react';
import {
  Modal,
  Pressable,
  View,
  Text,
  Animated,
  Easing,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radii } from '@/lib/theme';

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  /** Optional pinned footer (e.g. action buttons). Rendered OUTSIDE the
   *  scroll area so it can never scroll off the bottom of a tall sheet — the
   *  scrollable content shrinks to leave room for it within the maxHeight cap. */
  footer?: React.ReactNode;
};

export function Sheet({ open, onClose, title, subtitle, children, footer }: SheetProps) {
  const slide = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();

  useEffect(() => {
    Animated.timing(slide, {
      toValue: open ? 1 : 0,
      duration: open ? 280 : 200,
      easing: Easing.bezier(0.2, 0.8, 0.2, 1),
      useNativeDriver: true,
    }).start();
  }, [open, slide]);

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [600, 0] });
  const opacity = slide.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Animated.View style={{ flex: 1, backgroundColor: 'rgba(10,10,10,0.42)', opacity }}>
          <Pressable style={{ flex: 1 }} onPress={onClose} />
          <Animated.View
            style={{
              backgroundColor: colors.white,
              borderTopLeftRadius: radii.sheet,
              borderTopRightRadius: radii.sheet,
              maxHeight: '88%',
              transform: [{ translateY }],
            }}
          >
            <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
              <View
                style={{ width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2 }}
              />
            </View>
            {title ? (
              <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }}>
                <Text style={{ fontFamily: fonts.bold, fontSize: 18, color: colors.black }}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 13,
                      color: colors.textSecondary,
                      marginTop: 2,
                    }}
                  >
                    {subtitle}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <ScrollView
              keyboardShouldPersistTaps="handled"
              // flexShrink lets the ScrollView shrink to the parent's maxHeight
              // cap and scroll when content is tall; without it a tall sheet
              // (e.g. Mark delivered) overflows the cap and clips its content
              // off the bottom of the screen. No effect when content fits.
              style={{ flexShrink: 1 }}
              contentContainerStyle={{ paddingBottom: footer ? 8 : insets.bottom + 16 }}
            >
              {children}
            </ScrollView>
            {footer ? (
              <View
                style={{
                  paddingHorizontal: 20,
                  paddingTop: 10,
                  paddingBottom: insets.bottom + 12,
                  borderTopWidth: 1,
                  borderTopColor: colors.border,
                  backgroundColor: colors.white,
                }}
              >
                {footer}
              </View>
            ) : null}
          </Animated.View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
