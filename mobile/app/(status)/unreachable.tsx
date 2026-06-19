import { ActivityIndicator, Text, View } from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { Button, Icon, RedaMark } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

// Shown when sign-in worked but the profile fetch failed because the backend
// was unreachable (network drop, or a Supabase 5xx/503 outage). The provider
// is already retrying in the background with backoff — this screen just keeps
// the user informed and offers an immediate "Try again". Deliberately worded as
// a connection problem, NOT an account problem, so an outage doesn't send
// everyone to "contact your admin" (see useAuth / 2026-06-19 incident).
export default function UnreachableScreen() {
  const { signOut, retry } = useAuth();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.surface,
        paddingHorizontal: 24,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <RedaMark size={48} />
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: colors.warningSoft,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 32,
          marginBottom: 16,
        }}
      >
        <Icon name="alert" size={32} color={colors.warningDark} />
      </View>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 24,
          color: colors.black,
          letterSpacing: -0.5,
        }}
      >
        Can&apos;t reach Reda
      </Text>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 15,
          color: colors.textSecondary,
          textAlign: 'center',
          lineHeight: 22,
          marginTop: 12,
          marginBottom: 24,
          maxWidth: 320,
        }}
      >
        Your sign-in worked, but we couldn&apos;t load your account just now. This is usually a
        temporary connection or server issue, not a problem with your account.
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 28 }}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary }}>
          Retrying automatically…
        </Text>
      </View>
      <Button variant="primary" icon="refresh" onPress={retry}>
        Try again
      </Button>
      <View style={{ height: 12 }} />
      <Button variant="ghost" icon="logout" onPress={signOut}>
        Sign out
      </Button>
    </View>
  );
}
