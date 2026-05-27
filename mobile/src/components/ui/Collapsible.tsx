import React, { useState, useRef, useEffect } from 'react';
import { LayoutAnimation, Platform, Pressable, Text, UIManager, View } from 'react-native';
import { colors, fonts, radii } from '@/lib/theme';
import { Icon, type IconName } from './Icon';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export type CollapsibleProps = {
  title: string;
  icon?: IconName;
  /** If provided, the parent controls the expanded state. Otherwise local. */
  expanded?: boolean;
  /** Initial expanded state for the uncontrolled variant. */
  defaultExpanded?: boolean;
  onChange?: (expanded: boolean) => void;
  children: React.ReactNode;
};

export function Collapsible({
  title,
  icon,
  expanded: controlled,
  defaultExpanded = false,
  onChange,
  children,
}: CollapsibleProps) {
  const [local, setLocal] = useState(defaultExpanded);
  const isControlled = controlled !== undefined;
  const open = isControlled ? controlled : local;

  // When parent flips the controlled prop (e.g. deep-link auto-expand), animate
  // the transition the same way taps do.
  const prev = useRef(open);
  useEffect(() => {
    if (prev.current !== open) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      prev.current = open;
    }
  }, [open]);

  function toggle() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const next = !open;
    if (!isControlled) setLocal(next);
    onChange?.(next);
  }

  return (
    <View
      style={{
        backgroundColor: colors.white,
        borderRadius: radii.card,
        shadowColor: colors.black,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.06,
        shadowRadius: 3,
        elevation: 1,
        overflow: 'hidden',
      }}
    >
      <Pressable
        onPress={toggle}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          paddingHorizontal: 16,
          paddingVertical: 14,
          backgroundColor: pressed ? colors.surface : colors.white,
        })}
      >
        {icon ? <Icon name={icon} size={20} color={colors.textSecondary} /> : null}
        <Text
          style={{
            flex: 1,
            fontFamily: fonts.semibold,
            fontSize: 14,
            color: colors.black,
            letterSpacing: -0.1,
          }}
        >
          {title}
        </Text>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <Icon name="chevronDown" size={18} color={colors.textSecondary} />
        </View>
      </Pressable>
      {open ? (
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 4,
            paddingBottom: 14,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          {children}
        </View>
      ) : null}
    </View>
  );
}
