import { useCallback } from 'react';
import { Alert, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '@/hooks/useAuth';
import { useQueue } from './QueueProvider';

/**
 * Sign-out wrapper that blocks if there are unsynced mutations queued. Shows
 * an alert with three choices:
 *   - Cancel
 *   - Sign out anyway (drops the queue — destructive, requires double-tap)
 *   - Review pending (navigates to dead-letter screen)
 *
 * Use this everywhere instead of `useAuth().signOut` directly.
 */
export function useGuardedSignOut(): () => void {
  const { signOut } = useAuth();
  const { hasUnsynced, snapshot } = useQueue();
  const router = useRouter();

  return useCallback(() => {
    if (!hasUnsynced) {
      if (Platform.OS === 'web') {
        if (
          typeof window !== 'undefined' &&
          window.confirm('Sign out? You will need to sign in again to use the app.')
        ) {
          signOut();
        }
        return;
      }
      Alert.alert('Sign out?', 'You will need to sign in again to use the app.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
      ]);
      return;
    }
    const pending = snapshot.jobs.filter(
      (j) => j.status === 'pending' || j.status === 'in_flight' || j.status === 'failed_retrying',
    ).length;
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return;
      const msg = `You have ${pending} ${pending === 1 ? 'change' : 'changes'} that haven't synced. Signing out now will lose them.\n\nOK = sign out & discard.\nCancel = stay (review pending in the queue screen).`;
      if (window.confirm(msg)) {
        if (
          window.confirm(
            `Are you sure? This will discard ${pending} unsynced ${pending === 1 ? 'change' : 'changes'} permanently.`,
          )
        ) {
          signOut();
        }
      } else {
        router.push('/(queue)/dead-letter');
      }
      return;
    }
    Alert.alert(
      'Unsynced changes',
      `You have ${pending} ${pending === 1 ? 'change' : 'changes'} that haven't synced. Signing out now will lose them.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Review',
          onPress: () => router.push('/(queue)/dead-letter'),
        },
        {
          text: 'Sign out anyway',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are you sure?',
              `This will discard ${pending} unsynced ${pending === 1 ? 'change' : 'changes'} permanently.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Discard & sign out',
                  style: 'destructive',
                  onPress: () => signOut(),
                },
              ],
            );
          },
        },
      ],
    );
  }, [hasUnsynced, snapshot.jobs, signOut, router]);
}
