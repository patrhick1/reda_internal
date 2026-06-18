import { Text, View } from 'react-native';
import { Card, Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

/** Shows the delivery's free-text handling instructions to the agent (and ops)
 *  on the detail screens. Rendered as a labeled card with a calm info accent —
 *  noticeable enough not to be scrolled past, but not the red/amber alarm style
 *  reserved for problems. Renders nothing when there are no instructions.
 *
 *  Shared by the ops Detail screen and the agent today/[id] screen so the
 *  treatment stays identical (the agent is the primary reader). */
export function DeliveryInstructionsCard({ instructions }: { instructions: string | null }) {
  const text = instructions?.trim();
  if (!text) return null;
  return (
    <Card
      style={{
        backgroundColor: colors.infoSoft,
        borderWidth: 1,
        borderColor: colors.infoBorder,
        borderLeftWidth: 4,
        borderLeftColor: colors.info,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="message" size={14} color={colors.infoDark} />
        <Text
          style={{
            fontFamily: fonts.bold,
            fontSize: 11,
            letterSpacing: 0.6,
            textTransform: 'uppercase',
            color: colors.infoDark,
          }}
        >
          Delivery instructions
        </Text>
      </View>
      <Text
        style={{
          fontFamily: fonts.semibold,
          fontSize: 15,
          color: colors.black,
          lineHeight: 22,
          marginTop: 8,
        }}
      >
        {text}
      </Text>
    </Card>
  );
}
