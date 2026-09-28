import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePathname, router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  getBlacklistNoticeSummary,
  acknowledgeBlacklistNotices,
} from '@/services/blacklist-notices';
import { blockedOrdersRoute } from '@/lib/blacklist-notices';
import { colors, fonts } from '@/lib/theme';

/** A single quiet, in-flow notice: no popups, sound, or obstruction of forms. */
export function BlacklistNoticeHost({ userId, role }: { userId: string; role: string }) {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const enabled = !!blockedOrdersRoute(role);
  const summary = useQuery({
    queryKey: ['blacklist-notices', userId],
    queryFn: getBlacklistNoticeSummary,
    enabled,
    staleTime: 0,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const data = summary.data;
  // Keep order entry focused: its own inline refusal is the relevant feedback.
  const enteringOrder =
    pathname.endsWith('/deliveries/new') || /\/(?:needs-review|review)\/[^/]+$/.test(pathname);
  if (!enabled || !data?.count || pathname.startsWith('/call/') || enteringOrder) return null;
  const open = () => {
    const route = blockedOrdersRoute(role, data.inbound_id);
    if (route) router.push(route);
  };
  const acknowledge = async () => {
    if (!data.through_id || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await acknowledgeBlacklistNotices(data.through_id);
      await summary.refetch();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <View
      style={{
        backgroundColor: colors.warningSoft,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingHorizontal: 16,
        paddingTop: 10,
        paddingBottom: Math.max(insets.bottom, 8),
      }}
    >
      <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.warningDark }}>
        {data.count === 1
          ? '1 new order blocked by blacklist'
          : `${data.count} new orders blocked by blacklist`}
      </Text>
      <Text style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.warningDark }}>
        No deliveries created.{' '}
        {failed
          ? 'Could not mark seen. Try again.'
          : 'Review the details before contacting the vendor.'}
      </Text>
      <View style={{ flexDirection: 'row', gap: 24 }}>
        <Pressable
          accessibilityRole="button"
          onPress={open}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: fonts.bold, color: colors.warningDark }}>
            View blocked orders
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={saving}
          onPress={() => {
            void acknowledge();
          }}
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Text style={{ fontFamily: fonts.medium, color: colors.warningDark }}>
            {saving ? 'Saving…' : 'Mark seen'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
