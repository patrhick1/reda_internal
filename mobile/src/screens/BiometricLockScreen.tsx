import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { biometricLabel, promptBiometric } from '@/lib/biometric';
import { Button, Icon, RedaMark } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export function BiometricLockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { signOut } = useAuth();
  const [label, setLabel] = useState('Biometric');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    biometricLabel().then(setLabel);
  }, []);

  const tryUnlock = useCallback(async () => {
    setBusy(true);
    setError(null);
    const ok = await promptBiometric(`Unlock Reda with ${label}`);
    setBusy(false);
    if (ok) onUnlock();
    else setError('Authentication failed. Try again or sign out.');
  }, [label, onUnlock]);

  // Auto-prompt once on mount so the user doesn't have to tap a button first.
  useEffect(() => {
    tryUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.black,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <RedaMark size={72} inverted />
      <Text
        style={{
          marginTop: 28,
          color: colors.white,
          fontFamily: fonts.extrabold,
          fontSize: 22,
          letterSpacing: -0.4,
        }}
      >
        Locked
      </Text>
      <Text
        style={{
          marginTop: 8,
          color: colors.textTertiary,
          fontFamily: fonts.medium,
          fontSize: 14,
          textAlign: 'center',
        }}
      >
        Unlock with {label} to continue.
      </Text>

      {error ? (
        <Text
          style={{
            marginTop: 16,
            color: colors.red,
            fontFamily: fonts.medium,
            fontSize: 13,
            textAlign: 'center',
          }}
        >
          {error}
        </Text>
      ) : null}

      <View style={{ marginTop: 32, width: '100%', maxWidth: 320, gap: 12 }}>
        <Button variant="emphasis" full icon="lock" onPress={tryUnlock} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.white} /> : `Unlock with ${label}`}
        </Button>
        <Button variant="ghost" full onPress={signOut} disabled={busy}>
          Sign out
        </Button>
      </View>

      <View style={{ position: 'absolute', bottom: 32, opacity: 0.5 }}>
        <Icon name="lock" size={14} color={colors.textTertiary} />
      </View>
    </View>
  );
}
