// Admin-only Rep performance screen (Phase 1). Two lenses over a date range:
//   * Coverage / SLA panel — are we relaying status updates to clients, fast?
//   * Per-rep leaderboard — who's active, who's idle (Greg: "who to fire").
// Reached from a Quick action on the admin Home; registered as a hidden tab in
// (admin)/_layout.tsx. The (admin) route group already gates this to admins; the
// RPCs (rep_activity_summary, rep_notify_coverage) independently enforce is_admin.
//
// SLA target = 5 min (locked by Greg 2026-06-22). The "notifiable" denominator is
// the same set as the deliveries "To notify" pill — see tools/live-defs/
// rep-performance.sql and rep_performance_scope.md.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import {
  getRepCoverage,
  listRepActivity,
  type RepActivityRow,
  type RepCoverage,
} from '@/services/rep-performance';
import {
  AppBar,
  Avatar,
  Card,
  DateField,
  Empty,
  FilterChips,
  SectionHeader,
} from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatRangeLagos, isYmd, todayLagos } from '@/lib/date';
import { presetRange, type Preset } from '@/lib/reconcile';

// Locked SLA target. Drives the live indicator + median colouring.
const TARGET_MIN = 5;

export default function AdminRepPerformance() {
  const router = useRouter();
  const [from, setFrom] = useState<string>(todayLagos());
  const [to, setTo] = useState<string>(todayLagos());
  // Highlighted range chip — explicit UI state so "Custom" can be selected
  // directly (presetRange('custom') has no range to jump to). Editing From/To by
  // hand flips it to 'custom'. Cosmetic only; the RPCs read from/to.
  const [preset, setPreset] = useState<Preset>('today');

  // Gate the RPC fires behind YMD validation — the From/To inputs setState on
  // every keystroke and the RPCs reject malformed dates (mirrors reconcile).
  const rangeValid = isYmd(from) && isYmd(to);
  const coverageQ = useAsync(
    () => (rangeValid ? getRepCoverage(from, to) : Promise.resolve<RepCoverage | null>(null)),
    [from, to, rangeValid],
  );
  const repsQ = useAsync(
    () => (rangeValid ? listRepActivity(from, to) : Promise.resolve<RepActivityRow[]>([])),
    [from, to, rangeValid],
  );

  useFocusEffect(
    useCallback(() => {
      if (!rangeValid) return;
      coverageQ.reload();
      repsQ.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [from, to, rangeValid]),
  );

  // Ticking "now" so the live "last update relayed N min ago" indicator ages and
  // flips to red past the 5-min target without needing a refetch.
  const now = useNowEveryHalfMinute();

  const applyPreset = useCallback((p: Preset) => {
    setPreset(p);
    const r = presetRange(p);
    if (r) {
      setFrom(r.from);
      setTo(r.to);
    }
  }, []);

  const onChangeFrom = useCallback((v: string) => {
    setFrom(v);
    setPreset('custom');
  }, []);
  const onChangeTo = useCallback((v: string) => {
    setTo(v);
    setPreset('custom');
  }, []);

  const rangeLabel = formatRangeLagos(from, to);
  const loading = (coverageQ.loading && !coverageQ.data) || (repsQ.loading && !repsQ.data);
  const error = coverageQ.error ?? repsQ.error;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Rep performance" subtitle={rangeLabel} onBack={() => router.back()} />

      <View style={{ paddingTop: 12, backgroundColor: colors.surface }}>
        <FilterChips
          value={preset}
          onChange={(v) => applyPreset(v as Preset)}
          options={[
            { id: 'today', label: 'Today' },
            { id: 'yesterday', label: 'Yesterday' },
            { id: 'last7', label: 'Last 7 days' },
            { id: 'custom', label: 'Custom' },
          ]}
        />
      </View>
      <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16 }}>
        <View style={{ flex: 1 }}>
          <DateField label="From" value={from} onChange={onChangeFrom} />
        </View>
        <View style={{ flex: 1 }}>
          <DateField label="To" value={to} onChange={onChangeTo} />
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={(coverageQ.loading || repsQ.loading) && (!!coverageQ.data || !!repsQ.data)}
            onRefresh={() => {
              coverageQ.reload();
              repsQ.reload();
            }}
            tintColor={colors.black}
          />
        }
      >
        {error ? (
          <Empty icon="alert" title="Could not load" sub={error} />
        ) : loading ? (
          <View style={{ padding: 60, alignItems: 'center' }}>
            <ActivityIndicator color={colors.black} />
          </View>
        ) : (
          <>
            <CoveragePanel coverage={coverageQ.data} />
            <LiveIndicator lastAt={coverageQ.data?.last_team_notify_at ?? null} now={now} />

            <SectionHeader>Reps</SectionHeader>
            {(repsQ.data ?? []).length === 0 ? (
              <Empty icon="users" title="No active reps" sub="No reps to report on." />
            ) : (
              <View style={{ gap: 8 }}>
                {(repsQ.data ?? []).map((r) => (
                  <RepRow key={r.rep_id} row={r} now={now} />
                ))}
              </View>
            )}

            <Text style={caveat}>
              Counts a rep tapping “client notified” — their claim they messaged the vendor on
              WhatsApp, not proof of the send.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function CoveragePanel({ coverage }: { coverage: RepCoverage | null }) {
  if (!coverage) {
    return (
      <Card>
        <Text style={kicker}>Coverage</Text>
        <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
          No data for this range.
        </Text>
      </Card>
    );
  }
  const pct = Number(coverage.pct_notified);
  const pctColor = pct >= 95 ? colors.success : pct >= 80 ? colors.warningDark : colors.red;
  const median = coverage.median_minutes_to_notify;
  const medianColor =
    median == null ? colors.textSecondary : median <= TARGET_MIN ? colors.success : colors.red;

  return (
    <Card>
      <Text style={kicker}>Updates relayed to clients</Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 40,
          color: pctColor,
          letterSpacing: -1,
          marginTop: 4,
        }}
      >
        {pct}%
      </Text>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 13,
          color: colors.textSecondary,
          marginTop: 2,
        }}
      >
        {coverage.notified} of {coverage.notifiable_updates} updates notified ·{' '}
        {coverage.not_notified} missed
      </Text>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <Metric
          label="Median to notify"
          value={median == null ? '—' : `${median} min`}
          accent={medianColor}
          sub={`target ${TARGET_MIN} min`}
        />
        <Metric
          label="Open backlog"
          value={String(coverage.backlog_open)}
          accent={coverage.backlog_open > 0 ? colors.red : colors.success}
          sub={
            coverage.backlog_open > 0 && coverage.oldest_open_update_age_minutes != null
              ? `oldest ${formatDuration(coverage.oldest_open_update_age_minutes)}`
              : 'all relayed'
          }
        />
      </View>
    </Card>
  );
}

function LiveIndicator({ lastAt, now }: { lastAt: string | null; now: number }) {
  const mins = lastAt == null ? null : (now - Date.parse(lastAt)) / 60000;
  const stale = mins == null || mins > TARGET_MIN;
  const bg = mins == null ? colors.surfaceAlt : stale ? colors.redSoft : colors.successSoft;
  const fg = mins == null ? colors.textSecondary : stale ? colors.red : colors.success;
  const label =
    mins == null ? 'No client notifications yet' : `Last update relayed ${formatAgo(mins)}`;
  return (
    <Card dense style={{ backgroundColor: bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: fg,
          }}
        />
        <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: fg, flex: 1 }}>{label}</Text>
        {mins != null && stale ? (
          <Text style={{ fontFamily: fonts.bold, fontSize: 11, color: fg }}>
            {`> ${TARGET_MIN} min`}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}

function RepRow({ row, now }: { row: RepActivityRow; now: number }) {
  const idleMins =
    row.last_active_at == null ? null : (now - Date.parse(row.last_active_at)) / 60000;
  const idleLabel = idleMins == null ? 'No activity in range' : `Active ${formatAgo(idleMins)}`;
  return (
    <Card dense>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar user={{ display_name: row.display_name }} size={40} />
        <View style={{ flex: 1 }}>
          <Text
            style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}
            numberOfLines={1}
          >
            {row.display_name}
          </Text>
          <Text
            style={{
              fontFamily: fonts.medium,
              fontSize: 12,
              color: colors.textSecondary,
              marginTop: 2,
            }}
            numberOfLines={1}
          >
            {row.messages} {row.messages === 1 ? 'message' : 'messages'} · {row.calls}{' '}
            {row.calls === 1 ? 'call' : 'calls'} · {idleLabel}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={{
              fontFamily: fonts.extrabold,
              fontSize: 20,
              color: row.notifies > 0 ? colors.black : colors.textTertiary,
              letterSpacing: -0.4,
            }}
          >
            {row.notifies}
          </Text>
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: 10,
              color: colors.textSecondary,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              marginTop: 2,
            }}
          >
            Notified
          </Text>
        </View>
      </View>
    </Card>
  );
}

function Metric({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string;
  accent: string;
  sub: string;
}) {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.surfaceAlt,
        borderRadius: 12,
        padding: 12,
      }}
    >
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 10,
          color: colors.textSecondary,
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 22,
          color: accent,
          marginTop: 4,
          letterSpacing: -0.4,
        }}
      >
        {value}
      </Text>
      <Text
        style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.textTertiary, marginTop: 2 }}
      >
        {sub}
      </Text>
    </View>
  );
}

/** Re-render every 30s so relative-time labels age and the live indicator flips
 *  colour at the 5-min mark without a network refetch. */
function useNowEveryHalfMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** "just now" / "3m ago" / "1h 4m ago" / "2d ago" from a minute count. */
function formatAgo(minutes: number): string {
  if (minutes < 1) return 'just now';
  return `${formatDuration(minutes)} ago`;
}

/** "3m" / "1h 4m" / "2d" from a minute count. */
function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
  }
  return `${Math.floor(m / (60 * 24))}d`;
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};

const caveat = {
  fontFamily: fonts.medium,
  fontSize: 11,
  color: colors.textTertiary,
  marginTop: 4,
  lineHeight: 16,
};
