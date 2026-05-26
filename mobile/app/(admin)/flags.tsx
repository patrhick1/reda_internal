import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, Switch, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { listFeatureFlags, setFeatureFlag, type FeatureFlag } from '@/services/bot';
import { AppBar, Banner, Card, Empty } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';

export default function Flags() {
  const router = useRouter();
  const flagsQ = useAsync<FeatureFlag[]>(() => listFeatureFlags(), []);
  const [busy, setBusy] = useState<string | null>(null);

  useFocusEffect(useCallback(() => {
    flagsQ.reload();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

  const toggle = useCallback(async (key: string, next: boolean) => {
    setBusy(key);
    try {
      await setFeatureFlag(key, next);
      await flagsQ.reload();
    } catch (e) {
      Alert.alert('Toggle failed', errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [flagsQ]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Feature flags" subtitle="Runtime toggles for the bot pipeline" onBack={() => router.back()} />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={flagsQ.loading && !!flagsQ.data} onRefresh={flagsQ.reload} tintColor={colors.black} />}
      >
        {flagsQ.loading && !flagsQ.data ? (
          <View style={{ padding: 60, alignItems: 'center' }}><ActivityIndicator color={colors.black} /></View>
        ) : flagsQ.error ? (
          <Banner tone="error" icon="alert">{flagsQ.error}</Banner>
        ) : (flagsQ.data ?? []).length === 0 ? (
          <Empty icon="sliders" title="No flags defined" sub="Add rows to feature_flags in Supabase." />
        ) : null}

        {(flagsQ.data ?? []).map((f) => (
          <Card key={f.key}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <Text style={{ flex: 1, fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                {f.key}
              </Text>
              {busy === f.key
                ? <ActivityIndicator size="small" color={colors.black} />
                : (
                  <Switch
                    value={f.enabled}
                    onValueChange={(v) => toggle(f.key, v)}
                    trackColor={{ false: colors.border, true: colors.red }}
                    thumbColor={colors.white}
                  />
                )}
            </View>
            {f.description ? (
              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, marginTop: 8, lineHeight: 19 }}>
                {f.description}
              </Text>
            ) : null}
            <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textTertiary, marginTop: 8 }}>
              updated {new Date(f.updated_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}
            </Text>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
