import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import {
  listLocationChanges,
  approveLocationChange,
  rejectLocationChange,
  revertLocationChange,
  type LocationChangeRow,
} from '@/services/deliveries';
import { AppBar, Banner, Button, Card, Empty, Input, Sheet } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

type Tab = 'pending' | 'recent';
const RECENT_STATES = ['applied', 'approved', 'rejected', 'reverted'];

type Tone = { label: string; bg: string; fg: string };
const STATE_TONE: Record<string, Tone> = {
  pending: { label: 'awaiting approval', bg: colors.warningSoft, fg: colors.warningDark },
  applied: { label: 'auto-applied', bg: colors.successSoft, fg: colors.successDark },
  approved: { label: 'approved', bg: colors.successSoft, fg: colors.successDark },
  rejected: { label: 'rejected', bg: colors.closedSoft, fg: colors.closed },
  reverted: { label: 'reverted', bg: colors.closedSoft, fg: colors.closed },
};
const FALLBACK_TONE: Tone = { label: 'pending', bg: colors.warningSoft, fg: colors.warningDark };

export function LocationApprovalsScreen() {
  const [tab, setTab] = useState<Tab>('pending');
  const rowsQ = useAsync<LocationChangeRow[]>(
    () => listLocationChanges(tab === 'pending' ? ['pending'] : RECENT_STATES),
    [tab],
  );

  useFocusEffect(
    useCallback(() => {
      rowsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab]),
  );

  // Reason prompt for reject / revert (both require a reason).
  const [prompt, setPrompt] = useState<{ changeId: string; kind: 'reject' | 'revert' } | null>(
    null,
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function approve(changeId: string) {
    setBusy(changeId);
    setError(null);
    try {
      await approveLocationChange(changeId);
      rowsQ.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function confirmPrompt() {
    if (!prompt) return;
    if (!reason.trim()) {
      setError('Add a short reason');
      return;
    }
    setBusy(prompt.changeId);
    setError(null);
    try {
      if (prompt.kind === 'reject') await rejectLocationChange(prompt.changeId, reason.trim());
      else await revertLocationChange(prompt.changeId, reason.trim());
      setPrompt(null);
      setReason('');
      rowsQ.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Zone approvals" subtitle={`${(rowsQ.data ?? []).length} ${tab}`} />

      <View
        style={{
          flexDirection: 'row',
          gap: 20,
          paddingHorizontal: 16,
          backgroundColor: colors.white,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        {(['pending', 'recent'] as Tab[]).map((t) => {
          const active = tab === t;
          return (
            <Pressable
              key={t}
              onPress={() => setTab(t)}
              style={{
                paddingVertical: 14,
                borderBottomWidth: 2,
                borderBottomColor: active ? colors.red : 'transparent',
                marginBottom: -1,
              }}
            >
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: 13,
                  color: active ? colors.black : colors.textSecondary,
                }}
              >
                {t === 'pending' ? 'Pending' : 'Recent'}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <Banner tone="error" icon="alert">
            {error}
          </Banner>
        </View>
      ) : null}

      <FlatList
        data={rowsQ.data ?? []}
        keyExtractor={(r) => r.change_id}
        renderItem={({ item }) => (
          <ChangeCard
            row={item}
            busy={busy === item.change_id}
            onApprove={() => approve(item.change_id)}
            onReject={() => {
              setReason('');
              setError(null);
              setPrompt({ changeId: item.change_id, kind: 'reject' });
            }}
            onRevert={() => {
              setReason('');
              setError(null);
              setPrompt({ changeId: item.change_id, kind: 'revert' });
            }}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
        refreshControl={
          <RefreshControl
            refreshing={rowsQ.loading && !!rowsQ.data}
            onRefresh={rowsQ.reload}
            tintColor={colors.black}
          />
        }
        contentContainerStyle={{ padding: 16, paddingBottom: 32, flexGrow: 1 }}
        ListEmptyComponent={
          rowsQ.error ? (
            <Empty icon="alert" title="Could not load" sub={rowsQ.error} />
          ) : rowsQ.loading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={colors.black} />
            </View>
          ) : (
            <Empty
              icon="check"
              title={tab === 'pending' ? 'Nothing to approve' : 'Nothing yet'}
              sub={
                tab === 'pending'
                  ? 'When an agent records a delivery zone that raises their pay, it lands here for you to approve.'
                  : 'Recent zone changes will show here.'
              }
            />
          )
        }
      />

      <Sheet
        open={!!prompt}
        onClose={() => (busy ? undefined : setPrompt(null))}
        title={prompt?.kind === 'revert' ? 'Revert zone change' : 'Reject zone change'}
      >
        <View style={{ padding: 20, gap: 16, paddingBottom: 32 }}>
          <Banner tone={prompt?.kind === 'revert' ? 'warn' : 'info'} icon="alert">
            {prompt?.kind === 'revert'
              ? 'This restores the original zone and both money snapshots on the delivery. The agent is notified.'
              : 'The zone change will not be applied. The agent is notified.'}
          </Banner>
          <Input
            label="Reason"
            value={reason}
            onChange={setReason}
            placeholder="e.g. not our cost — customer moved themselves"
            autoCapitalize="sentences"
            multiline
            numberOfLines={3}
          />
          {error ? (
            <Banner tone="error" icon="alert">
              {error}
            </Banner>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button variant="secondary" onPress={() => setPrompt(null)} disabled={!!busy}>
              Cancel
            </Button>
            <Button
              variant={prompt?.kind === 'revert' ? 'destructive' : 'emphasis'}
              full
              onPress={confirmPrompt}
              disabled={!!busy}
            >
              {busy ? 'Working…' : prompt?.kind === 'revert' ? 'Revert' : 'Reject'}
            </Button>
          </View>
        </View>
      </Sheet>
    </View>
  );
}

function ChangeCard({
  row,
  busy,
  onApprove,
  onReject,
  onRevert,
}: {
  row: LocationChangeRow;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRevert: () => void;
}) {
  const tone = STATE_TONE[row.state] ?? FALLBACK_TONE;
  const payFrom = Number(row.from_agent_payment ?? 0);
  const payTo = Number(row.to_agent_payment ?? 0);
  const payDelta = payTo - payFrom;
  // Revert needs an original zone to restore to; first-time-set changes
  // (from_location_id null) can't be reverted — the server refuses them.
  const canRevert = (row.state === 'applied' || row.state === 'approved') && !!row.from_location_id;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <View
          style={{
            backgroundColor: tone.bg,
            paddingHorizontal: 10,
            paddingVertical: 4,
            borderRadius: 12,
          }}
        >
          <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: tone.fg }}>{tone.label}</Text>
        </View>
        <View style={{ flex: 1 }} />
        {row.scheduled_date ? (
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textSecondary }}>
            {row.scheduled_date}
          </Text>
        ) : null}
      </View>

      <Text style={{ fontFamily: fonts.bold, fontSize: 15, color: colors.black }}>
        {row.customer_name ?? '—'}
      </Text>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 12,
          color: colors.textSecondary,
          marginTop: 2,
        }}
      >
        {row.agent_name ?? 'agent'} · {row.current_status}
      </Text>

      <View
        style={{ marginTop: 10, padding: 10, backgroundColor: colors.surfaceAlt, borderRadius: 10 }}
      >
        <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.black }}>
          {(row.from_location_name ?? 'no zone') + '  →  ' + (row.to_location_name ?? '—')}
        </Text>
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: 12,
            color: payDelta > 0 ? colors.red : colors.textSecondary,
            marginTop: 4,
          }}
        >
          {`Agent pay ${formatNaira(payFrom)} → ${formatNaira(payTo)}`}
          {payDelta !== 0 ? ` (${payDelta > 0 ? '+' : ''}${formatNaira(payDelta)})` : ''}
        </Text>
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: 12,
            color: colors.textSecondary,
            marginTop: 2,
          }}
        >
          {`Reda charge ${formatNaira(Number(row.from_charged ?? 0))} → ${formatNaira(Number(row.to_charged ?? 0))}`}
        </Text>
        {row.state === 'pending' ? (
          <Text
            style={{
              fontFamily: fonts.regular,
              fontSize: 11,
              color: colors.textTertiary,
              marginTop: 4,
            }}
          >
            Recalculated from the current rate when you approve.
          </Text>
        ) : null}
      </View>

      {row.reason ? (
        <Text
          style={{ fontFamily: fonts.regular, fontSize: 13, color: colors.black, marginTop: 8 }}
        >
          “{row.reason}”
        </Text>
      ) : null}

      {row.state === 'pending' ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Button variant="secondary" onPress={onReject} disabled={busy}>
            Reject
          </Button>
          <Button variant="emphasis" full icon="check" onPress={onApprove} disabled={busy}>
            {busy ? 'Working…' : 'Approve'}
          </Button>
        </View>
      ) : canRevert ? (
        <View style={{ marginTop: 12, alignSelf: 'flex-start' }}>
          <Button variant="secondary" size="sm" onPress={onRevert} disabled={busy}>
            Revert
          </Button>
        </View>
      ) : null}
    </Card>
  );
}
