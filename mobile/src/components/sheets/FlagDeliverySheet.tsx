import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Banner, Input, Sheet, StatusPill } from '@/components/ui';
import { colors, fonts, STATUS_META } from '@/lib/theme';
import { type DeliveryRow } from '@/services/deliveries';
import {
  ACTIONABLE_ISSUE_TYPES,
  flagDelivery,
  ISSUE_DEFAULT_STATUS,
  ISSUE_LABELS,
  ISSUE_STATUS_OVERRIDES,
  type IssueType,
} from '@/services/delivery-messages';
import { newClientUuid } from '@/lib/uuid';
import { errorMessage } from '@/lib/errors';

// Chip order mirrors ACTIONABLE_ISSUE_TYPES — single source of truth for
// "issues that need ops to act." Auto-seeded types (cant_reach_client today)
// are excluded over there; this list inherits the exclusion automatically.
const ISSUE_ORDER: IssueType[] = ACTIONABLE_ISSUE_TYPES;

/** Lets the agent flag a delivery with a chip + optional note. The chip
 *  drives a default status transition (see ISSUE_DEFAULT_STATUS) so the
 *  deliveries list status pill reflects the open issue. */
export function FlagDeliverySheet({
  open,
  delivery,
  onClose,
  onCommitted,
}: {
  open: boolean;
  delivery: DeliveryRow | null;
  onClose: () => void;
  /** Called once the flag has been posted. Parent screen should reflect
   *  `newStatus` optimistically. `newStatus` is null when the agent
   *  declined to change status (only possible for the 'other' chip). */
  onCommitted: (newStatus: string | null) => void;
}) {
  const [picked, setPicked] = useState<IssueType | null>(null);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const [otherOptIn, setOtherOptIn] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generated once per sheet open so submit/retry uses the same idempotency
  // token. Regenerated when the user reopens the sheet for a fresh flag.
  const [clientUuid, setClientUuid] = useState<string>(() => newClientUuid());

  useEffect(() => {
    if (open) {
      setPicked(null);
      setStatusOverride(null);
      setOtherOptIn(false);
      setNote('');
      setError(null);
      setClientUuid(newClientUuid());
    }
  }, [open]);

  const derivedStatus = useMemo<string | null>(() => {
    if (!picked) return null;
    if (picked === 'other') return otherOptIn ? 'follow_up' : null;
    return statusOverride ?? ISSUE_DEFAULT_STATUS[picked];
  }, [picked, statusOverride, otherOptIn]);

  async function submit() {
    if (!delivery?.id || !picked) return;
    setSubmitting(true);
    setError(null);
    try {
      await flagDelivery({
        deliveryId: delivery.id,
        issueType: picked,
        note: note.trim() ? note.trim() : null,
        newStatus: derivedStatus,
        clientUuid,
      });
      onCommitted(derivedStatus);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!delivery) return null;

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="Flag this delivery"
      subtitle={delivery.customer_name ?? undefined}
    >
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 32, gap: 18 }}>
        <View>
          <Text style={kicker}>What&apos;s the issue?</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
            {ISSUE_ORDER.map((id) => {
              const active = picked === id;
              return (
                <Pressable
                  key={id}
                  onPress={() => {
                    setPicked(id);
                    setStatusOverride(null);
                    setOtherOptIn(false);
                  }}
                  style={({ pressed }) => [
                    {
                      paddingVertical: 8,
                      paddingHorizontal: 14,
                      borderRadius: 999,
                      borderWidth: 1,
                      backgroundColor: active ? colors.black : colors.white,
                      borderColor: active ? colors.black : colors.border,
                    },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Text
                    style={{
                      fontFamily: fonts.bold,
                      fontSize: 13,
                      color: active ? colors.white : colors.black,
                    }}
                  >
                    {ISSUE_LABELS[id]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {picked ? (
          <StatusSection
            picked={picked}
            derivedStatus={derivedStatus}
            statusOverride={statusOverride}
            setStatusOverride={setStatusOverride}
            otherOptIn={otherOptIn}
            setOtherOptIn={setOtherOptIn}
          />
        ) : null}

        <Input
          label="Note (optional)"
          value={note}
          onChange={setNote}
          placeholder="Anything ops should know to help"
          autoCapitalize="sentences"
          multiline
        />

        {error ? (
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable
            onPress={onClose}
            disabled={submitting}
            style={({ pressed }) => [
              {
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 999,
                borderWidth: 1.5,
                borderColor: colors.black,
                backgroundColor: colors.white,
              },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
              Cancel
            </Text>
          </Pressable>
          <Pressable
            onPress={submit}
            disabled={!picked || submitting}
            style={({ pressed }) => [
              {
                flex: 1,
                paddingVertical: 14,
                paddingHorizontal: 20,
                borderRadius: 999,
                backgroundColor: colors.black,
                alignItems: 'center',
                opacity: !picked || submitting ? 0.6 : 1,
              },
              pressed && picked && !submitting && { opacity: 0.92 },
            ]}
          >
            <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
              {submitting ? 'Sending…' : 'Send to ops'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </Sheet>
  );
}

function StatusSection({
  picked,
  derivedStatus,
  statusOverride,
  setStatusOverride,
  otherOptIn,
  setOtherOptIn,
}: {
  picked: IssueType;
  derivedStatus: string | null;
  statusOverride: string | null;
  setStatusOverride: (s: string | null) => void;
  otherOptIn: boolean;
  setOtherOptIn: (b: boolean) => void;
}) {
  const overrides = ISSUE_STATUS_OVERRIDES[picked];

  if (picked === 'other') {
    return (
      <View>
        <Text style={kicker}>Status</Text>
        <Pressable
          onPress={() => setOtherOptIn(!otherOptIn)}
          style={({ pressed }) => [
            {
              marginTop: 8,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingVertical: 12,
              paddingHorizontal: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: otherOptIn ? colors.surface : colors.white,
            },
            pressed && { opacity: 0.85 },
          ]}
        >
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              borderWidth: 1.5,
              borderColor: colors.black,
              backgroundColor: otherOptIn ? colors.black : colors.white,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {otherOptIn ? (
              <Text
                style={{
                  color: colors.white,
                  fontSize: 12,
                  fontFamily: fonts.bold,
                  lineHeight: 14,
                }}
              >
                ✓
              </Text>
            ) : null}
          </View>
          <Text style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.black }}>
            Also set status to Follow up
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      <Text style={kicker}>Status will change to</Text>
      <View
        style={{
          marginTop: 8,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <StatusPill status={derivedStatus ?? ''} />
        <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
          {STATUS_META[derivedStatus ?? '']?.desc ?? ''}
        </Text>
      </View>
      {overrides.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
          {overrides.map((s) => {
            const active = (statusOverride ?? ISSUE_DEFAULT_STATUS[picked]) === s;
            return (
              <Pressable
                key={s}
                onPress={() => setStatusOverride(s)}
                style={({ pressed }) => [
                  {
                    paddingVertical: 6,
                    paddingHorizontal: 10,
                    borderRadius: 999,
                    borderWidth: 1,
                    backgroundColor: active ? colors.black : colors.white,
                    borderColor: active ? colors.black : colors.border,
                  },
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text
                  style={{
                    fontFamily: fonts.bold,
                    fontSize: 11,
                    color: active ? colors.white : colors.black,
                  }}
                >
                  {STATUS_META[s]?.label ?? s}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
