import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatNaira } from '@/lib/format';
import { formatRangeLagos } from '@/lib/date';
import { colors, fonts } from '@/lib/theme';
import { newClientUuid } from '@/lib/uuid';
import {
  bulkSettleAgents,
  type AgentEarningsRow,
  type BulkSettleAgentsResult,
} from '@/services/reconciliation';

/** Review and atomically record several rider cash handovers for one day. */
export function BulkAgentHandoverSheet({
  open,
  selected,
  periodDate,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  selected: AgentEarningsRow[];
  periodDate: string;
  onClose: () => void;
  onConfirmed: (result: BulkSettleAgentsResult) => void;
}) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef('');

  useEffect(() => {
    if (!open) return;
    setNote('');
    setError(null);
    requestIdRef.current = newClientUuid();
  }, [open]);

  const total = useMemo(
    () => selected.reduce((sum, row) => sum + Number(row.total_remit), 0),
    [selected],
  );

  async function submit() {
    if (submitting || selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await bulkSettleAgents(
        selected.map((row) => row.agent_id),
        periodDate,
        note.trim() || null,
        requestIdRef.current,
      );
      onConfirmed(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="Confirm handovers"
      subtitle={`${selected.length} ${selected.length === 1 ? 'agent' : 'agents'} · ${formatRangeLagos(periodDate, periodDate)}`}
      footer={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button variant="secondary" onPress={onClose} disabled={submitting}>
            Cancel
          </Button>
          <View style={{ flex: 1 }}>
            <Button
              variant="emphasis"
              full
              icon="check"
              onPress={submit}
              disabled={submitting || selected.length === 0}
            >
              {submitting
                ? 'Recording…'
                : selected.length === 0
                  ? 'No agents selected'
                  : `Mark ${selected.length} handed over`}
            </Button>
          </View>
        </View>
      }
    >
      <View style={{ padding: 20, gap: 16 }}>
        <Banner tone="warn" icon="cash" title="Confirm the money is with Reda">
          This records every selected agent as fully handed over for this day. If one has not handed
          over, cancel and deselect that person first.
        </Banner>

        <View
          style={{
            backgroundColor: colors.surface,
            borderRadius: 14,
            padding: 14,
            gap: 8,
          }}
        >
          <SummaryRow label="Agents" value={String(selected.length)} />
          <SummaryRow label="Total received" value={formatNaira(total)} strong />
        </View>

        <View>
          <Text
            style={{
              fontFamily: fonts.semibold,
              fontSize: 12,
              color: colors.textSecondary,
              marginBottom: 8,
            }}
          >
            HANDOVERS IN THIS BATCH
          </Text>
          <View
            style={{
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 14,
              overflow: 'hidden',
            }}
          >
            {selected.map((row, index) => (
              <View
                key={row.agent_id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: colors.border,
                }}
              >
                <Text
                  numberOfLines={1}
                  style={{ flex: 1, fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
                >
                  {row.agent_name}
                </Text>
                <Text style={{ fontFamily: fonts.extrabold, fontSize: 14, color: colors.black }}>
                  {formatNaira(Number(row.total_remit))}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <Input
          label="Shared note (optional)"
          value={note}
          onChange={setNote}
          placeholder="e.g. cash counted by Uzo"
          autoCapitalize="sentences"
        />

        {error ? (
          <Banner tone="error" icon="alert" title="Nothing was recorded">
            {`${error} Refresh the list and try again.`}
          </Banner>
        ) : null}
      </View>
    </Sheet>
  );
}

function SummaryRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
        {label}
      </Text>
      <Text
        style={{
          fontFamily: strong ? fonts.extrabold : fonts.bold,
          fontSize: strong ? 17 : 13,
          color: colors.black,
        }}
      >
        {value}
      </Text>
    </View>
  );
}
