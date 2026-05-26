import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { colors, fonts } from '@/lib/theme';
import { Banner, type BannerTone } from './Banner';
import { Icon, type IconName } from './Icon';
import { useDismissibleHint } from '@/hints/useDismissibleHint';
import type { HintId } from '@/hints/registry';

const TONE_TEXT: Record<BannerTone, string> = {
  info:  colors.infoDark,
  warn:  colors.warningDark,
  error: colors.red,
  ok:    colors.successDark,
};

export type HintProps = {
  /** From `HINTS` in `mobile/src/hints/registry.ts`. Typed so typos fail at
   *  compile time + so the Profile "See hints again" path knows about it. */
  id: HintId;
  /** Defaults to `'info'` — the gentlest tone, matches the "did you know?" voice. */
  tone?: BannerTone;
  /** Defaults to `'helpCircle'`. */
  icon?: IconName;
  title?: string;
  children: React.ReactNode;
};

/** A one-time, dismissible "did you know?" banner.
 *
 *  Wraps `<Banner>` with a small "×" dismiss button. The wrapper renders
 *  nothing once the user has dismissed it (per-user, persisted in
 *  AsyncStorage). Use sparingly — convention is at most one Hint per screen
 *  at a time (web-research-backed ceiling).
 *
 *  ```tsx
 *  <Hint id={HINTS.EDIT_DELIVERY_ICON} title="Spotted a typo?">
 *    Tap the pencil icon in the top-right to fix customer name, phone, or
 *    address before delivery.
 *  </Hint>
 *  ```
 */
export function Hint({
  id,
  tone = 'info',
  icon = 'helpCircle',
  title,
  children,
}: HintProps) {
  const { visible, dismiss } = useDismissibleHint(id);
  if (!visible) return null;
  return (
    <Banner
      tone={tone}
      icon={icon}
      title={title}
      right={
        <TouchableOpacity
          onPress={dismiss}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss hint"
          style={{ padding: 2 }}
        >
          <Icon name="x" size={16} color={colors.textSecondary} />
        </TouchableOpacity>
      }
    >
      {/* Always wrap children in <Text> so callers can mix plain strings and
       *  nested <Text> elements for emphasis without tripping RN's
       *  "text strings must be rendered within a <Text>" rule. Banner only
       *  auto-wraps when children is exactly a single string. */}
      <Text style={{
        fontFamily: fonts.medium,
        fontSize:   13,
        color:      TONE_TEXT[tone],
        lineHeight: 19,
      }}>
        {children}
      </Text>
    </Banner>
  );
}
