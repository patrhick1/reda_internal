// Admin/dispatcher "New waybill / pickup" form. A waybill is a money-only order
// (no product, customer, phone, address, or agent): Reda books an Uber / pays a
// waybill driver to collect a client's stock, charges the client a (usually
// lower) fee, and may pass storekeeper/driver cash straight through.
//
// The user enters real-world amounts; the form does the bookkeeping:
//   charged = fee + Σ pass-throughs   (what we bill the client)
//   paid    = fare + Σ pass-throughs  (what Reda paid out)
//   margin  = fee − fare              (the trip subsidy; negative by design)
// Pass-throughs ride BOTH columns so they net to zero in margin & remittance.
// The cost breakdown note is generated from the lines, so it can never disagree
// with the numbers. Server (create_waybill) is the source of truth + gate.
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { listClients, type Client } from '@/services/clients';
import { createWaybill } from '@/services/deliveries';
import { AppBar, Banner, Button, Input } from '@/components/ui';
import { Select } from '@/components/Select';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

type Extra = { id: number; label: string; amount: string };

function num(s: string): number {
  const n = Number(s.replace(/[,₦\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export default function NewWaybill() {
  const clientsQ = useAsync<Client[]>(() => listClients(), []);

  const [clientId, setClientId] = useState<string | null>(null);
  const [label, setLabel] = useState('Waybill');
  const [fare, setFare] = useState(''); // trip fare Reda paid (Uber / driver)
  const [fee, setFee] = useState(''); // fee Reda charges the client
  const [extras, setExtras] = useState<Extra[]>([]);
  const [nextId, setNextId] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientOptions = useMemo(
    () => (clientsQ.data ?? []).map((c) => ({ value: c.id, label: c.name })),
    [clientsQ.data],
  );

  const fareNum = num(fare);
  const feeNum = num(fee);
  const extrasTotal = extras.reduce((s, e) => s + num(e.amount), 0);
  const charged = feeNum + extrasTotal;
  const paid = fareNum + extrasTotal;
  const margin = charged - paid; // = fee − fare

  const valid = !!clientId && fare.trim() !== '' && fee.trim() !== '';

  function addExtra() {
    setExtras((xs) => [...xs, { id: nextId, label: '', amount: '' }]);
    setNextId((n) => n + 1);
  }
  function updateExtra(id: number, patch: Partial<Extra>) {
    setExtras((xs) => xs.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }
  function removeExtra(id: number) {
    setExtras((xs) => xs.filter((e) => e.id !== id));
  }

  /** Breakdown of the CHARGED column: the fee, then each pass-through. */
  function buildNote(): string {
    const lines = [`Pickup ${formatNaira(feeNum)}`];
    for (const e of extras) {
      const label = e.label.trim() || 'Extra';
      if (num(e.amount) > 0) lines.push(`${label} ${formatNaira(num(e.amount))}`);
    }
    return lines.join('\n');
  }

  async function submit() {
    if (!clientId) {
      setError('Pick the client');
      return;
    }
    if (fare.trim() === '' || fee.trim() === '') {
      setError('Enter what you paid for the trip and what you charge');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createWaybill({
        clientId,
        charged,
        paid,
        note: buildNote(),
        label: label.trim() || 'Waybill',
      });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="New waybill / pickup" onBack={() => router.back()} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 14 }}>
          <Banner tone="info" icon="helpCircle">
            A waybill has no product or customer — just a client and the money. Enter what you paid
            and what you charge; the totals and the note are worked out for you.
          </Banner>

          <Select
            label="Client"
            value={clientId}
            options={clientOptions}
            onChange={setClientId}
            placeholder={clientsQ.loading ? 'Loading clients…' : 'Pick the client'}
            searchable
          />

          <Input
            label="Label (shown as the customer name)"
            value={label}
            onChange={setLabel}
            placeholder="Waybill"
          />

          <Input
            label="Trip fare we paid (Uber / driver)"
            value={fare}
            onChange={setFare}
            keyboardType="numeric"
            placeholder="e.g. 6000"
          />
          <Input
            label="Fee we charge the client"
            value={fee}
            onChange={setFee}
            keyboardType="numeric"
            placeholder="e.g. 3000"
          />

          <View style={{ gap: 8 }}>
            <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
              Extra cash paid at pickup (client covers these)
            </Text>
            {extras.map((e) => (
              <View key={e.id} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
                <View style={{ flex: 1.4 }}>
                  <Input
                    label="What for"
                    value={e.label}
                    onChange={(v) => updateExtra(e.id, { label: v })}
                    placeholder="Storekeeper"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Input
                    label="Amount"
                    value={e.amount}
                    onChange={(v) => updateExtra(e.id, { amount: v })}
                    keyboardType="numeric"
                    placeholder="500"
                  />
                </View>
                <Button variant="secondary" onPress={() => removeExtra(e.id)} disabled={submitting}>
                  ✕
                </Button>
              </View>
            ))}
            <Button variant="secondary" onPress={addExtra} disabled={submitting}>
              + Add line
            </Button>
          </View>

          {/* Live preview */}
          <View
            style={{
              backgroundColor: colors.surfaceAlt,
              borderRadius: 12,
              padding: 14,
              gap: 6,
            }}
          >
            <PreviewRow label="You'll record — Paid" value={formatNaira(paid)} />
            <PreviewRow label="Charged" value={formatNaira(charged)} />
            <PreviewRow
              label="Margin"
              value={formatNaira(margin)}
              accent={margin < 0 ? colors.red : colors.success}
            />
            {margin < 0 ? (
              <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
                Reda is subsidising {formatNaira(-margin)} of the trip.
              </Text>
            ) : null}
          </View>

          {error ? (
            <Banner tone="error" icon="alert">
              {error}
            </Banner>
          ) : null}

          <Button onPress={submit} disabled={!valid || submitting} full>
            {submitting ? 'Creating…' : 'Create waybill'}
          </Button>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function PreviewRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
        {label}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: accent ?? colors.black }}>
        {value}
      </Text>
    </View>
  );
}
