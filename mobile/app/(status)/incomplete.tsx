import { View, Text } from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { Button, Icon, RedaMark } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

export default function IncompleteScreen() {
  const { signOut } = useAuth();
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface, paddingHorizontal: 24, alignItems: 'center', justifyContent: 'center' }}>
      <RedaMark size={48} />
      <View style={{
        width: 64, height: 64, borderRadius: 32,
        backgroundColor: colors.warningSoft,
        alignItems: 'center', justifyContent: 'center',
        marginTop: 32, marginBottom: 16,
      }}>
        <Icon name="settings" size={32} color={colors.warningDark} />
      </View>
      <Text style={{ fontFamily: fonts.extrabold, fontSize: 24, color: colors.black, letterSpacing: -0.5 }}>
        Setup incomplete
      </Text>
      <Text style={{
        fontFamily: fonts.medium, fontSize: 15, color: colors.textSecondary,
        textAlign: 'center', lineHeight: 22, marginTop: 12, marginBottom: 28, maxWidth: 320,
      }}>
        Your sign-in worked, but your account hasn&apos;t been fully set up yet. Contact your admin to finish setup.
      </Text>
      <Button variant="primary" icon="logout" onPress={signOut}>Sign out</Button>
    </View>
  );
}
