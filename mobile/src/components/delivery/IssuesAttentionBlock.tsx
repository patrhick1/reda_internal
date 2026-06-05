import { Text, TouchableOpacity, View } from 'react-native';
import { Card, Icon, StatusPill } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { ISSUE_LABELS, type OpenIssueRow } from '@/services/delivery-messages';

/** Ops "Needs Attention" card listing open agent-flagged issues that require
 *  someone to actually act (wrong_address, payment_dispute, product_issue,
 *  other). Auto-seeded `cant_reach_client` threads are filtered out server-
 *  side in listOpenIssuesForOps so they don't double up with the soft-fail
 *  card. Used on both the admin home and the dispatcher OpsDashboard — the
 *  caller wires `onOpen` to its own basePath so the same card works under
 *  /(admin)/... and /(dispatcher)/... without the component knowing about
 *  routing. */
export function IssuesAttentionBlock({
  issues,
  onOpen,
}: {
  issues: OpenIssueRow[];
  onOpen: (deliveryId: string) => void;
}) {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            backgroundColor: colors.redSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="alert" size={18} color={colors.red} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
            {issues.length} open {issues.length === 1 ? 'issue' : 'issues'} from agents
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            Tap a row to open
          </Text>
        </View>
      </View>
      <View style={{ marginTop: 4, gap: 6 }}>
        {issues.map((row) => (
          <TouchableOpacity
            key={row.delivery_id}
            onPress={() => onOpen(row.delivery_id)}
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
                {row.issue_type ? ISSUE_LABELS[row.issue_type] : 'Issue'}
                {row.agent_name ? ` · ${row.agent_name}` : ''}
              </Text>
            </View>
            {row.current_status ? (
              <StatusPill status={row.current_status} variant="subtle" size="sm" />
            ) : null}
            <Icon name="chevronRight" size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        ))}
      </View>
    </Card>
  );
}
