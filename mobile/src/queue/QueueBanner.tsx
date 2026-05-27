import { useMemo } from 'react';
import { Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fonts } from '@/lib/theme';
import { Icon } from '@/components/ui';
import { useQueue } from './QueueProvider';

/**
 * Sticky one-line banner shown above the tab bar when there's anything the
 * user should know about sync state. Stays hidden during the happy path
 * (online + zero queued + zero dead-letter) so it doesn't add noise.
 */
export function QueueBanner() {
  const router = useRouter();
  const { snapshot } = useQueue();
  const { jobs, online, draining } = snapshot;

  const tone = useMemo(() => {
    const dead = jobs.filter((j) => j.status === 'dead_letter').length;
    const pending = jobs.filter((j) => j.status === 'pending' || j.status === 'in_flight').length;
    const retrying = jobs.filter((j) => j.status === 'failed_retrying').length;

    if (dead > 0) {
      return {
        bg: colors.redSoft,
        fg: colors.red,
        icon: 'alert' as const,
        text: `${dead} ${dead === 1 ? 'change' : 'changes'} failed — tap to review`,
        onPress: () => router.push('/(queue)/dead-letter'),
      };
    }
    if (!online) {
      return {
        bg: colors.warningSoft,
        fg: colors.warningDark,
        icon: 'alert' as const,
        text:
          pending > 0
            ? `Offline · ${pending} queued`
            : 'Offline · changes will sync when reconnected',
        onPress: null,
      };
    }
    if (retrying > 0) {
      return {
        bg: colors.warningSoft,
        fg: colors.warningDark,
        icon: 'refresh' as const,
        text: `Reconnecting · ${retrying} ${retrying === 1 ? 'retry' : 'retries'} pending`,
        onPress: () => router.push('/(queue)/dead-letter'),
      };
    }
    if (draining || pending > 0) {
      return {
        bg: colors.infoSoft,
        fg: colors.infoDark,
        icon: 'refresh' as const,
        text: pending > 0 ? `Syncing ${pending}…` : 'Syncing…',
        onPress: null,
      };
    }
    return null;
  }, [jobs, online, draining, router]);

  if (!tone) return null;

  return (
    <Pressable
      onPress={tone.onPress ?? (() => undefined)}
      disabled={!tone.onPress}
      style={({ pressed }) => [
        {
          backgroundColor: tone.bg,
          paddingHorizontal: 16,
          paddingVertical: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          borderTopWidth: 1,
          borderTopColor: 'rgba(0,0,0,0.06)',
        },
        pressed && tone.onPress ? { opacity: 0.85 } : null,
      ]}
    >
      <Icon name={tone.icon} size={16} color={tone.fg} />
      <Text
        style={{
          flex: 1,
          fontFamily: fonts.semibold,
          fontSize: 12,
          color: tone.fg,
        }}
      >
        {tone.text}
      </Text>
      {tone.onPress ? <Icon name="chevronRight" size={14} color={tone.fg} /> : null}
    </Pressable>
  );
}
