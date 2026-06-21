// Bottom sheet that shows the original WhatsApp message for an order. Used on
// the warehouse "Available orders" drilldown, where rows have no full Detail
// route — tapping a row opens this so the warehouse manager can read the
// verbatim source text (name / phone / address / product notes) and copy it.
//
// Shares RawMessageBody with BotRawMessageCard, but shown expanded immediately
// since the sheet is opened expressly to read the message.
import { Text, View } from 'react-native';
import { Sheet } from '@/components/ui';
import { RawMessageBody } from '@/components/delivery/RawMessageBody';
import { colors, fonts } from '@/lib/theme';

export function RawMessageSheet({
  open,
  onClose,
  customerName,
  message,
}: {
  open: boolean;
  onClose: () => void;
  customerName: string;
  message: string | null | undefined;
}) {
  const trimmed = message?.trim() ?? '';

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Original WhatsApp message"
      subtitle={customerName || undefined}
    >
      <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
        {trimmed ? (
          <RawMessageBody message={trimmed} />
        ) : (
          <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
            No WhatsApp message for this order — it was added manually.
          </Text>
        )}
      </View>
    </Sheet>
  );
}
