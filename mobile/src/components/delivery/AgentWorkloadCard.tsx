import { ActivityIndicator, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Avatar, Card, SectionHeader } from '@/components/ui';
import type { DeliveryRow } from '@/services/deliveries';
import type { AppUser } from '@/services/users';
import { colors, fonts } from '@/lib/theme';

type BasePath = '/(admin)' | '/(dispatcher)' | '/(rep)';

export function AgentWorkloadCard({
  deliveries,
  agents,
  loading,
  basePath,
  limit = 6,
}: {
  deliveries: DeliveryRow[];
  agents: AppUser[];
  loading: boolean;
  basePath: BasePath;
  limit?: number;
}) {
  const router = useRouter();
  return (
    <>
      <SectionHeader
        right={
          <Text
            style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary }}
            onPress={() => router.push(`${basePath}/deliveries`)}
          >
            See all →
          </Text>
        }
      >
        Agent workload
      </SectionHeader>
      {loading && agents.length === 0 ? (
        <ActivityIndicator color={colors.black} />
      ) : agents.length === 0 ? (
        <Card>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 13,
              color: colors.textSecondary,
              textAlign: 'center',
              paddingVertical: 8,
            }}
          >
            No active agents yet.
          </Text>
        </Card>
      ) : (
        <View style={{ gap: 8 }}>
          {agents.slice(0, limit).map((a) => {
            const aDels = deliveries.filter((d) => d.assigned_agent_id === a.id);
            const pending = aDels.filter((d) =>
              ['pending', 'available'].includes(d.current_status ?? ''),
            ).length;
            const done = aDels.filter((d) => d.current_status === 'delivered').length;
            const total = aDels.length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <Card key={a.id} dense>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <Avatar user={a} size={40} />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
                      numberOfLines={1}
                    >
                      {a.display_name}
                    </Text>
                    <Text
                      style={{
                        fontFamily: fonts.medium,
                        fontSize: 12,
                        color: colors.textSecondary,
                        marginTop: 2,
                      }}
                    >
                      {done}/{total} delivered · {pending} pending
                    </Text>
                    <View
                      style={{
                        marginTop: 6,
                        height: 4,
                        backgroundColor: colors.surface,
                        borderRadius: 2,
                        overflow: 'hidden',
                      }}
                    >
                      <View
                        style={{
                          height: '100%',
                          width: `${pct}%`,
                          backgroundColor: colors.success,
                        }}
                      />
                    </View>
                  </View>
                  <Text
                    style={{
                      fontFamily: fonts.extrabold,
                      fontSize: 18,
                      color: colors.black,
                      letterSpacing: -0.4,
                    }}
                  >
                    {pct}%
                  </Text>
                </View>
              </Card>
            );
          })}
        </View>
      )}
    </>
  );
}
