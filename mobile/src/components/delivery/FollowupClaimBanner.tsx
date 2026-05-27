import { useCallback, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  claimFollowup,
  getFollowup,
  releaseFollowup,
  type ActiveFollowup,
} from '@/services/followups';
import { useSupabaseChannel } from '@/hooks/useSupabaseChannel';
import { Banner, Button } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function ageLabel(iso: string): string {
  const m = minutesAgo(iso);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export type FollowupClaimBannerProps = {
  deliveryId: string;
  /** The currently signed-in user's id. Used to decide which of the three
   *  banner states to render. */
  currentUserId: string;
};

export function FollowupClaimBanner({ deliveryId, currentUserId }: FollowupClaimBannerProps) {
  const [claim, setClaim] = useState<ActiveFollowup | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const c = await getFollowup(deliveryId);
      setClaim(c);
    } catch (e) {
      setError(errorMessage(e));
      setClaim(null);
    }
  }, [deliveryId]);

  // Refresh on focus so a claim/release made elsewhere (or by a teammate)
  // shows up the moment this screen is foregrounded, not just on mount.
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  // Realtime: when a teammate claims, takes-over, or releases this delivery's
  // followup, every other rep watching the screen sees it without refocusing.
  // Filtered server-side to this delivery_id so the channel only fires on
  // changes that matter to this screen. Pairs with
  // scripts/delivery-followups-realtime.sql which adds the table to the
  // supabase_realtime publication.
  useSupabaseChannel(
    `delivery-followup:${deliveryId}`,
    (ch) =>
      ch.on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'delivery_followups',
          filter: `delivery_id=eq.${deliveryId}`,
        },
        () => {
          void reload();
        },
      ),
    [deliveryId, reload],
  );

  const onClaim = useCallback(
    async (takeover = false) => {
      setBusy(true);
      setError(null);
      try {
        await claimFollowup(deliveryId, takeover);
        await reload();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [deliveryId, reload],
  );

  const onRelease = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await releaseFollowup(deliveryId);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [deliveryId, reload]);

  if (claim === undefined) {
    return (
      <View style={{ paddingVertical: 8, alignItems: 'center' }}>
        <ActivityIndicator color={colors.black} />
      </View>
    );
  }

  if (error) {
    return (
      <Banner tone="error" icon="alert">
        {error}
      </Banner>
    );
  }

  // No one holds it — invite the caller to claim.
  if (claim === null) {
    return (
      <Banner tone="warn" icon="phone" title="Needs follow-up">
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: 13,
            color: colors.warningDark,
            lineHeight: 19,
          }}
        >
          Reaching out to the customer? Tap{' '}
          <Text style={{ fontFamily: fonts.bold }}>I&apos;ll handle this</Text> so the rest of the
          team knows.
        </Text>
        <View style={{ marginTop: 10 }}>
          <Button variant="emphasis" icon="check" onPress={() => onClaim(false)} disabled={busy}>
            {busy ? 'Claiming…' : "I'll handle this"}
          </Button>
        </View>
      </Banner>
    );
  }

  // Caller already holds it.
  if (claim.user_id === currentUserId) {
    return (
      <Banner tone="ok" icon="check" title="You're handling this">
        <Text
          style={{
            fontFamily: fonts.medium,
            fontSize: 13,
            color: colors.successDark,
            lineHeight: 19,
          }}
        >
          Started {ageLabel(claim.claimed_at)}. Tap{' '}
          <Text style={{ fontFamily: fonts.bold }}>Release</Text> when you&apos;re done so the team
          can pick it back up. Changing the status releases it automatically.
        </Text>
        <View style={{ marginTop: 10 }}>
          <Button variant="secondary" icon="x" onPress={onRelease} disabled={busy}>
            {busy ? 'Releasing…' : 'Release'}
          </Button>
        </View>
      </Banner>
    );
  }

  // Someone else holds it.
  return (
    <Banner tone="info" icon="user" title={`${claim.holder_name} is handling this`}>
      <Text
        style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.infoDark, lineHeight: 19 }}
      >
        Started {ageLabel(claim.claimed_at)}. Skip this one — only tap{' '}
        <Text style={{ fontFamily: fonts.bold }}>Take over</Text> if they&apos;ve stopped.
      </Text>
      <View style={{ marginTop: 10 }}>
        <Button variant="secondary" icon="lock" onPress={() => onClaim(true)} disabled={busy}>
          {busy ? 'Taking over…' : 'Take over'}
        </Button>
      </View>
    </Banner>
  );
}
