import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppBar, Avatar, Empty, Icon } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/lib/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  listCallHistory,
  initiateCall,
  initiateTeamCall,
  type CallHistoryRow,
  type CallStatus,
} from '@/services/calls';

const MISSED_STATUSES: CallStatus[] = ['missed', 'declined', 'cancelled'];

export default function CallHistoryScreen() {
  const router = useRouter();
  const { account } = useAuth();
  const { highlight } = useLocalSearchParams<{ highlight?: string }>();
  const userId = account.kind === 'active' ? account.userId : null;

  const [rows, setRows] = useState<CallHistoryRow[]>([]);
  const [loading, setL] = useState(true);
  const [refreshing, setR] = useState(false);
  const [callingId, setCID] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const data = await listCallHistory(userId, 50);
      setRows(data);
    } catch (err) {
      Alert.alert('Could not load call history', err instanceof Error ? err.message : String(err));
    } finally {
      setL(false);
      setR(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const onRedial = useCallback(
    async (row: CallHistoryRow) => {
      if (!userId || callingId) return;
      setCID(row.id);
      try {
        // Team-call redial → re-fire the team ring; otherwise dial the peer.
        // A missed/cancelled team call has callee_id=null, so peer-based
        // redial doesn't apply.
        const isTeamRow = row.callee_audience === 'ops_team' || row.callee_id === null;
        const call = isTeamRow
          ? await initiateTeamCall({ relatedDeliveryId: row.related_delivery_id })
          : await initiateCall({
              calleeId: (row.caller_id === userId ? row.callee_id : row.caller_id) as string,
              relatedDeliveryId: row.related_delivery_id,
            });
        router.push(`/call/${call.id}`);
      } catch (err) {
        Alert.alert('Could not start call', err instanceof Error ? err.message : String(err));
      } finally {
        setCID(null);
      }
    },
    [userId, callingId, router],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Call history" onBack={() => router.back()} />
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : rows.length === 0 ? (
        <Empty
          icon="phone"
          title="No calls yet"
          sub="Calls to and from your teammates will appear here."
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: spacing.xl, paddingBottom: 80 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setR(true);
                load();
              }}
            />
          }
          renderItem={({ item }) => (
            <Row
              row={item}
              userId={userId!}
              highlighted={item.id === highlight}
              calling={callingId === item.id}
              disabled={callingId !== null && callingId !== item.id}
              onRedial={() => onRedial(item)}
            />
          )}
        />
      )}
    </View>
  );
}

function Row({
  row,
  userId,
  highlighted,
  calling,
  disabled,
  onRedial,
}: {
  row: CallHistoryRow;
  userId: string;
  highlighted: boolean;
  calling: boolean;
  disabled: boolean;
  onRedial: () => void;
}) {
  const isOutgoing = row.caller_id === userId;
  const peerName = (isOutgoing ? row.callee_name : row.caller_name) ?? 'Unknown';
  const missed = MISSED_STATUSES.includes(row.status);
  const isMissedIncoming = !isOutgoing && missed;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: highlighted ? colors.warningSoft : colors.white,
        borderRadius: radii.card,
        borderWidth: 1,
        borderColor: highlighted ? colors.warning : colors.border,
        padding: spacing.lg,
        marginBottom: spacing.md,
      }}
    >
      <Avatar user={{ display_name: peerName }} size={42} />
      <View style={{ flex: 1, marginLeft: spacing.lg }}>
        <Text
          style={{
            fontFamily: fonts.semibold,
            fontSize: 15,
            color: isMissedIncoming ? colors.red : colors.textPrimary,
          }}
        >
          {peerName}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 }}>
          <Icon
            name={isOutgoing ? 'arrowUp' : 'arrowDown'}
            size={12}
            color={missed ? colors.red : colors.success}
          />
          <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary }}>
            {labelFor(row, isOutgoing)}
          </Text>
        </View>
        <Text
          style={{
            fontFamily: fonts.regular,
            fontSize: 11,
            color: colors.textTertiary,
            marginTop: 2,
          }}
        >
          {formatTime(row.created_at)}
        </Text>
      </View>
      <TouchableOpacity
        onPress={onRedial}
        disabled={disabled || calling}
        hitSlop={8}
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: colors.success,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.3 : 1,
        }}
      >
        {calling ? (
          <ActivityIndicator color={colors.white} size="small" />
        ) : (
          <Icon name="phone" size={18} color={colors.white} />
        )}
      </TouchableOpacity>
    </View>
  );
}

function labelFor(row: CallHistoryRow, isOutgoing: boolean): string {
  switch (row.status) {
    case 'completed':
      return row.duration_seconds
        ? `${isOutgoing ? 'Outgoing' : 'Incoming'} · ${formatDuration(row.duration_seconds)}`
        : isOutgoing
          ? 'Outgoing'
          : 'Incoming';
    case 'missed':
      return 'Missed';
    case 'declined':
      return isOutgoing ? 'Declined' : 'Declined';
    case 'cancelled':
      return isOutgoing ? 'Cancelled' : 'Cancelled';
    case 'ringing':
      return 'Ringing…';
    case 'accepted':
      return 'In progress';
    case 'failed':
      return 'Failed';
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  return (
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) +
    ' · ' +
    d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })
  );
}
