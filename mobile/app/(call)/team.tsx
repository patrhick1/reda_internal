import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, ActivityIndicator, Alert, RefreshControl, Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppBar, Avatar, Banner, Empty, Icon } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/lib/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  listCallableUsers, initiateCall, type CallableUser,
} from '@/services/calls';
import { ensureMicPermission } from '@/lib/calls/permissions';
import { canPlaceCall, CALL_UNSUPPORTED_HINT } from '@/lib/calls/availability';

const ROLE_LABEL: Record<string, string> = {
  admin:      'Admin',
  dispatcher: 'Dispatcher',
  rep:        'Rep',
  agent:      'Agent',
  warehouse:  'Warehouse',
};
const ROLE_ORDER = ['admin', 'dispatcher', 'rep', 'agent', 'warehouse'] as const;

export default function TeamScreen() {
  const router = useRouter();
  const { account } = useAuth();
  // Optional context: if the user got here via "Call a teammate" on a
  // delivery detail screen, the delivery id rides along as a query param.
  // We pass it to initiateCall so the resulting call row is linked.
  const { related_delivery_id } = useLocalSearchParams<{ related_delivery_id?: string }>();
  const relatedDeliveryId = typeof related_delivery_id === 'string' && related_delivery_id.length > 0
    ? related_delivery_id
    : null;
  const [users, setUsers]       = useState<CallableUser[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [callingId, setCallingId] = useState<string | null>(null);

  const userId = account.kind === 'active' ? account.userId : null;

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const rows = await listCallableUsers(userId);
      setUsers(rows);
    } catch (err: any) {
      Alert.alert('Could not load team', err?.message ?? String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const onCall = useCallback(async (target: CallableUser) => {
    if (callingId) return;
    if (!canPlaceCall()) {
      Alert.alert('Calls not available on web', CALL_UNSUPPORTED_HINT);
      return;
    }
    setCallingId(target.id);
    try {
      const micOk = await ensureMicPermission();
      if (!micOk) {
        Alert.alert(
          'Microphone needed',
          'Reda needs the microphone to make calls. Tap "Open settings" → Permissions → Microphone → Allow.',
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => { /* noop */ }); } },
          ],
        );
        return;
      }
      const call = await initiateCall({
        calleeId:          target.id,
        relatedDeliveryId: relatedDeliveryId,
      });
      router.push(`/call/${call.id}`);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Translate the partial-unique-index 40001 into something humans
      // recognize. The DB message is "caller or callee already has a ringing call".
      if (msg.includes('ringing call')) {
        Alert.alert('Already on a call', 'You or this person already has a call ringing. Try again in a moment.');
      } else {
        Alert.alert('Could not start call', msg);
      }
    } finally {
      setCallingId(null);
    }
  }, [callingId, router]);

  // Group by role, preserve display-name ordering within each role.
  const sections = ROLE_ORDER.map((role) => ({
    role,
    label: ROLE_LABEL[role] ?? role,
    rows: users.filter((u) => u.role === role),
  })).filter((s) => s.rows.length > 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Team"
        subtitle={canPlaceCall() ? 'Tap a name to start a call' : 'Calls available on the mobile app'}
        onBack={() => router.back()}
      />
      {!canPlaceCall() ? (
        <View style={{ paddingHorizontal: spacing.xl, paddingTop: spacing.lg }}>
          <Banner tone="info" icon="phone" title="Calls work on the mobile app">
            {CALL_UNSUPPORTED_HINT}
          </Banner>
        </View>
      ) : null}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : sections.length === 0 ? (
        <Empty icon="users" title="No teammates yet" sub="Once admin adds users you can call them here." />
      ) : (
        <FlatList
          contentContainerStyle={{ padding: spacing.xl, paddingBottom: 80 }}
          data={sections}
          keyExtractor={(s) => s.role}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
            />
          }
          renderItem={({ item: section }) => (
            <View style={{ marginBottom: spacing['2xl'] }}>
              <Text style={{
                fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary,
                textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: spacing.md,
              }}>
                {section.label}
              </Text>
              <View style={{
                backgroundColor: colors.white,
                borderRadius: radii.card,
                borderWidth: 1,
                borderColor: colors.border,
                overflow: 'hidden',
              }}>
                {section.rows.map((u, i) => (
                  <Row
                    key={u.id}
                    user={u}
                    isLast={i === section.rows.length - 1}
                    busy={callingId === u.id}
                    disabled={!canPlaceCall() || (callingId !== null && callingId !== u.id)}
                    onPress={() => onCall(u)}
                  />
                ))}
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

function Row({
  user, isLast, busy, disabled, onPress,
}: {
  user: CallableUser;
  isLast: boolean;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || busy}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row', alignItems: 'center',
        paddingVertical: spacing.lg, paddingHorizontal: spacing.xl,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.border,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <Avatar user={{ display_name: user.display_name }} size={40} />
      <View style={{ flex: 1, marginLeft: spacing.lg }}>
        <Text style={{ fontFamily: fonts.semibold, fontSize: 15, color: colors.textPrimary }}>
          {user.display_name}
        </Text>
        <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, marginTop: 2 }}>
          {ROLE_LABEL[user.role] ?? user.role}
        </Text>
      </View>
      <View style={{
        width: 40, height: 40, borderRadius: 20,
        backgroundColor: busy ? colors.successSoft : colors.success,
        alignItems: 'center', justifyContent: 'center',
      }}>
        {busy
          ? <ActivityIndicator color={colors.success} size="small" />
          : <Icon name="phone" size={20} color={colors.white} />}
      </View>
    </TouchableOpacity>
  );
}
