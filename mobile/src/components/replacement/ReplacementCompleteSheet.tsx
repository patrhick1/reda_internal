import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Banner, Button, Input, Sheet } from '@/components/ui';
import { Select } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';
import { useEnqueueCompleteReplacement } from '@/queue/mutations';
import {
  RETURN_INSTRUCTION_LABELS,
  RETURN_OUTCOME_LABELS,
  type ReplacementDetails,
  type ReturnOutcome,
} from '@/services/replacements';

type Draft = { outcome: ReturnOutcome | null; quantity: string; notes: string };

export function ReplacementCompleteSheet({
  open,
  deliveryId,
  customerName,
  details,
  onClose,
  onCommitted,
}: {
  open: boolean;
  deliveryId: string;
  customerName: string | null;
  details: ReplacementDetails | null;
  onClose: () => void;
  onCommitted: (status: string, jobId: string) => void;
}) {
  const enqueue = useEnqueueCompleteReplacement();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !details) return;
    setDrafts(
      Object.fromEntries(
        details.returns.map((item) => [
          item.id,
          { outcome: null, quantity: String(item.quantity_expected), notes: '' },
        ]),
      ),
    );
    setNotes('');
    setError(null);
  }, [open, details]);

  function update(id: string, patch: Partial<Draft>) {
    setDrafts((rows) => ({
      ...rows,
      [id]: { ...(rows[id] ?? { outcome: null, quantity: '', notes: '' }), ...patch },
    }));
  }

  async function submit() {
    if (!details) return;
    for (const item of details.returns) {
      const draft = drafts[item.id];
      const qty = Number(draft?.quantity ?? '');
      if (!draft?.outcome) {
        setError(`Choose what happened to ${item.product_name}.`);
        return;
      }
      if (!Number.isInteger(qty) || qty < 0 || qty > item.quantity_expected) {
        setError(`Return quantity for ${item.product_name} must be 0–${item.quantity_expected}.`);
        return;
      }
      if ((draft.outcome === 'usable_collected' || draft.outcome === 'damaged_collected') && qty <= 0) {
        setError(`Enter how many ${item.product_name} were collected.`);
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const jobId = await enqueue(
        {
          deliveryId,
          returnOutcomes: details.returns.map((item) => {
            const draft = drafts[item.id]!;
            return {
              returnItemId: item.id,
              outcome: draft.outcome!,
              quantity: Number(draft.quantity),
              notes: draft.notes.trim() || null,
            };
          }),
          notes: notes.trim() || null,
        },
        `Complete replacement · ${customerName ?? ''}`,
      );
      onCommitted('replacement_completed', jobId);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title="Complete replacement"
      subtitle={customerName ?? undefined}
      footer={
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button variant="secondary" onPress={onClose} disabled={submitting}>Cancel</Button>
          <Button full variant="emphasis" icon="check" onPress={submit} disabled={submitting || !details}>
            {submitting ? 'Saving…' : 'Confirm exchange'}
          </Button>
        </View>
      }
    >
      <View style={{ padding: 20, gap: 16 }}>
        <Banner tone="warn" icon="alert" title="Returned goods are not stock yet">
          Anything collected stays with the rider. Warehouse must receive and inspect it before a usable
          item is added to stock. Damaged items are never added to usable stock.
        </Banner>
        {(details?.returns ?? []).map((item) => {
          const draft = drafts[item.id];
          return (
            <View key={item.id} style={itemCard}>
              <Text style={itemName}>{item.product_name} · expected {item.quantity_expected}</Text>
              <Text style={instruction}>{RETURN_INSTRUCTION_LABELS[item.vendor_instruction]}</Text>
              <Select
                label="What happened to the old product?"
                value={draft?.outcome ?? null}
                options={Object.entries(RETURN_OUTCOME_LABELS).map(([value, label]) => ({
                  value: value as ReturnOutcome,
                  label,
                }))}
                onChange={(value) => update(item.id, { outcome: value })}
                required
              />
              <Input
                label="Quantity"
                value={draft?.quantity ?? ''}
                onChange={(value) => update(item.id, { quantity: value })}
                keyboardType="numeric"
              />
              <Input
                label="Item note"
                value={draft?.notes ?? ''}
                onChange={(value) => update(item.id, { notes: value })}
                placeholder="Condition or vendor instruction followed"
              />
            </View>
          );
        })}
        <Input label="Completion note" value={notes} onChange={setNotes} multiline />
        {error ? <Banner tone="error" icon="alert">{error}</Banner> : null}
      </View>
    </Sheet>
  );
}

const itemCard = { gap: 10, padding: 12, borderRadius: 12, backgroundColor: colors.surface };
const itemName = { fontFamily: fonts.bold, fontSize: 14, color: colors.black };
const instruction = { fontFamily: fonts.medium, fontSize: 12, color: colors.warningDark, lineHeight: 17 };
