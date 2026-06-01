// Collapsible card that surfaces the original WhatsApp message that produced
// the delivery row (deliveries.bot_raw_message). The parsed name / phone /
// address fields on Detail are derived from this text by the bot's parser;
// when something looks wrong (typo in landmark, dropped digit, missing
// "leave with security" note), this is the source of truth.
//
// Collapsed by default to keep Detail scan-fast. One tap reveals the
// verbatim text plus a Copy button. Renders nothing when the row has no
// raw message (manual orders).
import { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Card, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export function BotRawMessageCard({ message }: { message: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const trimmed = message?.trim() ?? '';

  const onCopy = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(trimmed);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard failed silently — the text remains selectable when expanded */
    }
  }, [trimmed]);

  if (!trimmed) return null;

  return (
    <Card>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Hide original message' : 'Show original message'}
        onPress={() => setExpanded((v) => !v)}
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="message" size={14} color={colors.textSecondary} />
          <Text style={kicker}>Original WhatsApp message</Text>
        </View>
        <Icon
          name={expanded ? 'chevronUp' : 'chevronDown'}
          size={16}
          color={colors.textSecondary}
        />
      </TouchableOpacity>

      {expanded ? (
        <View style={{ marginTop: 10 }}>
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
              style={{
                fontFamily: fonts.mono,
                fontSize: 13,
                lineHeight: 20,
                color: colors.black,
              }}
            >
              {trimmed}
            </Text>
          </View>
          <TouchableOpacity
            onPress={onCopy}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              marginTop: 8,
              alignSelf: 'flex-start',
              paddingVertical: 4,
              paddingHorizontal: 10,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: copied ? colors.success : colors.borderStrong,
            }}
          >
            {copied ? <Icon name="check" size={12} color={colors.success} /> : null}
            <Text
              style={{
                fontFamily: fonts.medium,
                fontSize: 11,
                color: copied ? colors.success : colors.textSecondary,
              }}
            >
              {copied ? 'Copied' : 'Copy message'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </Card>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
