import { View, Text } from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { Button, Icon, RedaMark } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export default function DeactivatedScreen() {
  const { signOut } = useAuth();
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
          backgroundColor: colors.redSoft,
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 32,
          marginBottom: 16,
        }}
      >
        <Icon name="alert" size={32} color={colors.red} />
      </View>
      <Text
        style={{
          fontFamily: fonts.extrabold,
          fontSize: 24,
          color: colors.black,
          letterSpacing: -0.5,
        }}
      >
        Account deactivated
      </Text>
      <Text
        style={{
          fontFamily: fonts.medium,
          fontSize: 15,
          color: colors.textSecondary,
          textAlign: 'center',
          lineHeight: 22,
          marginTop: 12,
          marginBottom: 28,
          maxWidth: 320,
        }}
      >
        Your account has been deactivated. If you think this is a mistake, contact your admin.
      </Text>
      <Button variant="primary" icon="logout" onPress={signOut}>
        Sign out
      </Button>
    </View>
  );
}
