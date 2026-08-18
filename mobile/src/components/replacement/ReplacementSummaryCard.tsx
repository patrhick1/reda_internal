import { Text, View } from 'react-native';
import { ActivityIndicator } from 'react-native';
import { Banner, Button, Card, StatusPill } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatDateTime, formatNaira } from '@/lib/format';
import {
  ATTEMPT_OUTCOME_LABELS,
  REPLACEMENT_REASON_LABELS,
  RETURN_INSTRUCTION_LABELS,
  type ReplacementDetails,
} from '@/services/replacements';

const CUSTODY_LABELS: Record<string, string> = {
  expected: 'Expected from customer',
  with_rider_usable_pending_inspection: 'With rider — warehouse inspection pending',
  with_rider_damaged_hold: 'Damaged — with rider for warehouse handoff',
  left_with_customer: 'Left with customer',
  discarded: 'Discarded as instructed',
  warehouse_accepted_stock: 'Inspected and added to warehouse stock',
  warehouse_hold_for_vendor: 'Warehouse is holding it for the vendor',
  warehouse_rejected_damaged: 'Warehouse rejected it as damaged',
  returned_to_vendor: 'Returned to vendor',
};

export function ReplacementSummaryCard({
  details,
  loading,
  error,
  showFinancials,
  onEditAttemptFees,
}: {
  details: ReplacementDetails | null;
  loading: boolean;
  error: string | null;
  showFinancials: boolean;
  onEditAttemptFees?: (attempt: ReplacementDetails['attempts'][number]) => void;
}) {
  return (
    <Card style={{ gap: 14 }}>
      <View>
        <Text style={kicker}>Replacement workflow</Text>
        <Text style={title}>Exchange trip and returned-item custody</Text>
      </View>
      {loading && !details ? (
        <ActivityIndicator color={colors.black} />
      ) : error ? (
        <Banner tone="error" icon="alert">
          {error}
        </Banner>
      ) : !details ? (
        <Banner tone="warn" icon="alert">
          Replacement details are unavailable.
        </Banner>
      ) : (
        <>
          <View style={section}>
            <Text style={label}>Reason</Text>
            <Text style={value}>
              {REPLACEMENT_REASON_LABELS[details.job.reason] ?? details.job.reason}
            </Text>
            {details.job.notes ? <Text style={note}>{details.job.notes}</Text> : null}
          </View>

          <View style={{ gap: 8 }}>
            <Text style={label}>Expected back from customer</Text>
            {details.returns.map((item) => (
              <View key={item.id} style={returnRow}>
                <View style={{ flex: 1 }}>
                  <Text style={value}>{item.product_name}</Text>
                  <Text style={note}>
                    Qty {item.actual_quantity ?? item.quantity_expected} ·{' '}
                    {CUSTODY_LABELS[item.custody_state] ?? item.custody_state}
                  </Text>
                  {item.custody_state === 'expected' ? (
                    <Text style={[note, { color: colors.warningDark }]}>
                      {RETURN_INSTRUCTION_LABELS[item.vendor_instruction]}
                    </Text>
                  ) : null}
                  {item.current_holder_name ? (
                    <Text style={note}>Current holder: {item.current_holder_name}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>

          {showFinancials ? (
            <View style={section}>
              <Text style={label}>Successful-trip terms</Text>
              <Text style={note}>
                Client charge {formatNaira(details.job.success_client_charge)} · rider pay{' '}
                {formatNaira(details.job.success_agent_payment)}
              </Text>
            </View>
          ) : null}

          {details.attempts.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={label}>Attempts</Text>
              {details.attempts.map((attempt) => (
                <View key={attempt.id} style={attemptRow}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <StatusPill status={attempt.status_after} />
                    <Text style={[note, { flex: 1, textAlign: 'right' }]}>
                      {formatDateTime(attempt.attempted_at)}
                    </Text>
                  </View>
                  <Text style={value}>
                    {attempt.outcome === 'completed'
                      ? 'Replacement completed'
                      : ATTEMPT_OUTCOME_LABELS[attempt.outcome]}
                  </Text>
                  {attempt.notes ? <Text style={note}>{attempt.notes}</Text> : null}
                  {showFinancials ? (
                    <View style={{ marginTop: 6, gap: 6 }}>
                      <Text style={note}>
                        Client charge {formatNaira(attempt.client_charge)} · rider pay{' '}
                        {formatNaira(attempt.agent_payment)}
                      </Text>
                      {onEditAttemptFees ? (
                        <View style={{ alignSelf: 'flex-start' }}>
                          <Button
                            variant="secondary"
                            size="sm"
                            icon="edit"
                            onPress={() => onEditAttemptFees(attempt)}
                          >
                            Correct fee
                          </Button>
                        </View>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}
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
const title = { fontFamily: fonts.bold, fontSize: 16, color: colors.black, marginTop: 4 };
const label = { fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary };
const value = { fontFamily: fonts.bold, fontSize: 14, color: colors.black, marginTop: 2 };
const note = {
  fontFamily: fonts.medium,
  fontSize: 12,
  lineHeight: 17,
  color: colors.textSecondary,
  marginTop: 3,
};
const section = {
  paddingTop: 12,
  borderTopWidth: 1,
  borderTopColor: colors.border,
};
const returnRow = {
  backgroundColor: colors.surface,
  padding: 12,
  borderRadius: 10,
  flexDirection: 'row' as const,
};
const attemptRow = {
  borderTopWidth: 1,
  borderTopColor: colors.border,
  paddingTop: 10,
};
