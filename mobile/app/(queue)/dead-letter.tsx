import { Alert, FlatList, Platform, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { AppBar, Banner, Button, Card, Empty } from '@/components/ui';
import { useQueue } from '@/queue/QueueProvider';
import { colors, fonts } from '@/lib/theme';
import type { Job } from '@/queue/types';

export default function DeadLetterReview() {
  const router = useRouter();
  const { snapshot, retry, drop, drainNow } = useQueue();
  const failing = snapshot.jobs.filter(
    (j) => j.status === 'dead_letter' || j.status === 'failed_retrying',
  );

  function confirmDrop(job: Job) {
    if (Platform.OS === 'web') {
      if (
        typeof window !== 'undefined' &&
        window.confirm(
          `Discard this change?\n\n${job.label}\n\nThis can't be undone. The server will not be updated.`,
        )
      ) {
        drop([job.id]);
      }
      return;
    }
    Alert.alert(
      'Discard this change?',
      `${job.label}\n\nThis can't be undone. The server will not be updated.`,
      [
        { text: 'Keep', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => drop([job.id]) },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Sync issues"
        subtitle={`${failing.length} ${failing.length === 1 ? 'change' : 'changes'} need attention`}
        onBack={() => router.back()}
      />
      <FlatList
        data={failing}
        keyExtractor={(j) => j.id}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ padding: 16, gap: 8, flexGrow: 1 }}
        ListHeaderComponent={
          failing.length > 0 ? (
            <Banner tone="info" icon="bot" style={{ marginBottom: 8 }}>
              These changes are saved on your device but the server refused them. Retry or discard
              each.
            </Banner>
          ) : null
        }
        renderItem={({ item }) => (
          <JobCard
            job={item}
            onRetry={() => retry([item.id])}
            onDiscard={() => confirmDrop(item)}
          />
        )}
        ListEmptyComponent={<Empty icon="check" title="All synced" sub="Nothing pending review." />}
        ListFooterComponent={
          failing.length > 0 ? (
            <View style={{ marginTop: 16, gap: 8 }}>
              <Button
                variant="primary"
                full
                icon="refresh"
                onPress={() => retry(failing.map((j) => j.id))}
              >
                Retry all
              </Button>
              <Button variant="secondary" full icon="refresh" onPress={drainNow}>
                Force sync now
              </Button>
            </View>
          ) : null
        }
      />
    </View>
  );
}

function JobCard({
  job,
  onRetry,
  onDiscard,
}: {
  job: Job;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const isDead = job.status === 'dead_letter';
  const ageMin = Math.max(0, Math.floor((Date.now() - job.createdAt) / 60_000));
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
            numberOfLines={2}
          >
            {job.label}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
          >
            {prettyKind(job.kind)} · queued {ageMin}m ago · {job.attempts}{' '}
            {job.attempts === 1 ? 'attempt' : 'attempts'}
          </Text>
        </View>
        <View
          style={{
            backgroundColor: isDead ? colors.redSoft : colors.warningSoft,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 999,
          }}
        >
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: 10,
              color: isDead ? colors.red : colors.warningDark,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
            }}
          >
            {isDead ? 'Failed' : 'Retrying'}
          </Text>
        </View>
      </View>
      {job.lastError ? (
        <View
          style={{ marginTop: 8, padding: 10, backgroundColor: colors.surfaceAlt, borderRadius: 8 }}
        >
          <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textSecondary }}>
            {job.lastError}
          </Text>
        </View>
      ) : null}
      {isDead ? (
        <View style={{ marginTop: 12, flexDirection: 'row', gap: 8 }}>
          <Button variant="destructive" size="sm" onPress={onDiscard}>
            Discard
          </Button>
          <Button variant="primary" size="sm" icon="refresh" onPress={onRetry}>
            Retry
          </Button>
        </View>
      ) : null}
    </Card>
  );
}

function prettyKind(kind: Job['kind']): string {
  switch (kind) {
    case 'change_delivery_status':
      return 'Status update';
    case 'create_stock_adjustment':
      return 'Stock adjustment';
    case 'create_stock_transfer':
      return 'Stock transfer';
    case 'agent_change_delivery_location':
      return 'Zone change';
    default:
      return kind;
  }
}
