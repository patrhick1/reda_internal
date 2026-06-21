// Collapsible card that surfaces the original WhatsApp message that produced
// the delivery row (deliveries.bot_raw_message). The parsed name / phone /
// address fields on Detail are derived from this text by the bot's parser;
// when something looks wrong (typo in landmark, dropped digit, missing
// "leave with security" note), this is the source of truth.
//
// Collapsed by default to keep Detail scan-fast. One tap reveals the
// verbatim text plus a Copy button. Renders nothing when the row has no
// raw message (manual orders).
import { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Card, Icon } from '@/components/ui';
import { RawMessageBody } from './RawMessageBody';
import { colors, fonts } from '@/lib/theme';

export function BotRawMessageCard({ message }: { message: string | null | undefined }) {
  const [expanded, setExpanded] = useState(false);
  const trimmed = message?.trim() ?? '';

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
          <RawMessageBody message={trimmed} />
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
