// Verbatim WhatsApp message in a mono block + a Copy button. Shared by the
// collapsible Detail card (BotRawMessageCard) and the warehouse RawMessageSheet
// so the two presentations can't drift. Caller passes an already-trimmed,
// non-empty string.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export function RawMessageBody({ message }: { message: string }) {
  const [copied, setCopied] = useState(false);
  // Track the reset timer so we can clear it on unmount / re-copy and never
  // fire setState on an unmounted component.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const onCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(message);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard failed silently — the text stays selectable above */
    }
  }, [message]);

  return (
    <View>
      <View
        style={{
          backgroundColor: colors.surface,
          borderRadius: 10,
          padding: 12,
          borderLeftWidth: 3,
          borderLeftColor: colors.borderStrong,
        }}
      >
        <Text
          selectable
          style={{ fontFamily: fonts.mono, fontSize: 13, lineHeight: 20, color: colors.black }}
        >
          {message}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onCopy}
        accessibilityRole="button"
        accessibilityLabel="Copy message"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginTop: 10,
          alignSelf: 'flex-start',
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: copied ? colors.success : colors.borderStrong,
        }}
      >
        {copied ? <Icon name="check" size={12} color={colors.success} /> : null}
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: 12,
            color: copied ? colors.success : colors.textSecondary,
          }}
        >
          {copied ? 'Copied' : 'Copy message'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
