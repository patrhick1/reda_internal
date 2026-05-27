import { Text, View } from 'react-native';
import { useCurrentUser } from '@/hooks/useAuth';
import { Button, RedaMark } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { useGuardedSignOut } from '@/queue/useGuardedSignOut';

export function RoleStub({ tab }: { tab: string }) {
  const signOut = useGuardedSignOut();
  const user = useCurrentUser();

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
      <Text
        style={{
          fontFamily: fonts.bold,
          fontSize: 11,
          letterSpacing: 1.2,
          color: colors.textSecondary,
          marginTop: 24,
          textTransform: 'uppercase',
        }}
      >
        {user.role}
      </Text>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 28,
          color: colors.black,
          letterSpacing: -0.6,
          marginTop: 6,
        }}
      >
        {tab}
      </Text>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 14,
          color: colors.textSecondary,
          marginTop: 16,
        }}
      >
        Signed in as {user.displayName}
      </Text>
      <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textTertiary }}>
        {user.email}
      </Text>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 13,
          color: colors.textSecondary,
          marginTop: 28,
          marginBottom: 20,
        }}
      >
        Stub screen — feature lands in a later phase.
      </Text>
      <Button variant="primary" icon="logout" onPress={signOut}>
        Sign out
      </Button>
    </View>
  );
}
