// Shared "Recent activity" list for home dashboards. Renders the section
// header (with a "See all →" link to /deliveries) and the first N rows of
// today's deliveries, tapping a row routes to its detail screen.
//
// Used by the admin home and the rep home. The basePath prop scopes both
// the see-all link and the per-row tap target to the caller's route group
// so admin and rep land on their own delivery detail screens.
import { ActivityIndicator, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { deliveryProductsLabel, type DeliveryRow } from '@/services/deliveries';
import { Card, SectionHeader, StatusPill } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNaira } from '@/lib/format';

type RecentBasePath = '/(admin)' | '/(rep)';

type Props = {
  rows: DeliveryRow[];
  loading: boolean;
  basePath: RecentBasePath;
  limit?: number;
};

export function RecentActivityCard({ rows, loading, basePath, limit = 4 }: Props) {
  const router = useRouter();
  const recent = rows.slice(0, limit);

  return (
    <>
      <SectionHeader
        right={
          <Text
            style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary }}
            onPress={() => router.push(`${basePath}/deliveries` as `${RecentBasePath}/deliveries`)}
          >
            See all →
          </Text>
        }
      >
        Recent activity
      </SectionHeader>
      {loading && rows.length === 0 ? (
        <ActivityIndicator color={colors.black} />
      ) : recent.length === 0 ? (
        <Card>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 13,
              color: colors.textSecondary,
              textAlign: 'center',
              paddingVertical: 12,
            }}
          >
            No deliveries today yet. They&apos;ll appear here as orders come in.
          </Text>
        </Card>
      ) : (
        <View style={{ gap: 8 }}>
          {recent.map((d) => (
            <Card
              key={d.id}
              dense
              onPress={() =>
                router.push({
                  pathname: `${basePath}/deliveries/[id]` as `${RecentBasePath}/deliveries/[id]`,
                  params: { id: d.id! },
                })
              }
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text
                      style={{ flex: 1, fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
                      numberOfLines={1}
                    >
                      {d.customer_name}
                    </Text>
                    <StatusPill status={d.current_status ?? 'pending'} variant="subtle" size="sm" />
                  </View>
                  <Text
                    style={{
                      fontFamily: fonts.medium,
                      fontSize: 12,
                      color: colors.textSecondary,
                      marginTop: 2,
                    }}
                    numberOfLines={1}
                  >
                    {deliveryProductsLabel(d)} · {d.assigned_agent_name ?? 'Unassigned'}
                  </Text>
                </View>
                <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.black }}>
                  {formatNaira(d.customer_price)}
                </Text>
              </View>
            </Card>
          ))}
        </View>
      )}
    </>
  );
}
