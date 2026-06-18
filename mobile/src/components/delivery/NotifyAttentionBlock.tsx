import { Text, TouchableOpacity, View } from 'react-native';
import { Card, Icon, StatusPill } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { deliveryProductsLabel, type DeliveryRow } from '@/services/deliveries';

/** Rep "Awaiting client notification" card: deliveries whose latest status change
 *  the client hasn't been told about yet (see awaitsClientNotification). It's one
 *  of the two things a rep leads their day with — new statuses to relay — sitting
 *  beside IssuesAttentionBlock (the other: agent messages). The caller passes the
 *  already-filtered, freshest-first rows; the card caps the visible list and routes
 *  overflow to the deliveries "To notify" filter via onViewAll, so the home stays
 *  tight while every row stays reachable. Tone is info/blue to read as a to-do, not
 *  the red alarm of an agent-flagged issue. */
const MAX_ROWS = 6;

export function NotifyAttentionBlock({
  rows,
  onOpen,
  onViewAll,
}: {
  rows: DeliveryRow[];
  onOpen: (deliveryId: string) => void;
  onViewAll: () => void;
}) {
  const shown = rows.slice(0, MAX_ROWS);
  const overflow = rows.length - shown.length;
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: colors.infoSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="bell" size={18} color={colors.info} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
            {rows.length} awaiting client update
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            Message the client, then mark notified
          </Text>
        </View>
      </View>
      <View style={{ marginTop: 4, gap: 6 }}>
        {shown.map((row) => {
          const id = row.id;
          if (!id) return null;
          return (
            <TouchableOpacity
              key={id}
              onPress={() => onOpen(id)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingVertical: 8,
                paddingHorizontal: 10,
                borderRadius: 10,
                backgroundColor: colors.surface,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text
                  style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}
                  numberOfLines={1}
                >
                  {row.customer_name ?? 'Customer'}
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginTop: 2,
                  }}
                  numberOfLines={1}
                >
                  {deliveryProductsLabel(row)}
                  {row.assigned_agent_name ? ` · ${row.assigned_agent_name}` : ''}
                </Text>
              </View>
              {row.current_status ? (
                <StatusPill status={row.current_status} variant="subtle" size="sm" />
              ) : null}
              <Icon name="chevronRight" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          );
        })}
      </View>
      {overflow > 0 ? (
        <TouchableOpacity
          onPress={onViewAll}
          style={{ marginTop: 8, paddingVertical: 8, alignItems: 'center' }}
          accessibilityRole="button"
          accessibilityLabel={`View all ${rows.length} deliveries awaiting client notification`}
        >
          <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.info }}>
            View all {rows.length}
          </Text>
        </TouchableOpacity>
      ) : null}
    </Card>
  );
}
