import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useCurrentUser } from '@/hooks/useAuth';
import { updateSelfProfile } from '@/services/users';
import { AppBar, Button, Card, Icon, Input } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { formatNgPhone } from '@/lib/format';
import { errorMessage } from '@/lib/errors';

export default function EditProfileScreen() {
  const router = useRouter();
  const user = useCurrentUser();

  const [displayName, setDisplayName] = useState(user.displayName);
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = displayName.trim() !== user.displayName || phone.trim() !== '';
  const nameValid = displayName.trim().length >= 2;
  const phoneDigits = phone.replace(/\D/g, '');
  const phoneValid = phoneDigits === '' || /^(0\d{10}|234\d{10})$/.test(phoneDigits);

  async function save() {
    if (!nameValid) { setError('Display name must be at least 2 characters'); return; }
    if (!phoneValid) { setError('Phone should look like 0803 123 4567 or +234 803 123 4567'); return; }
    setError(null);
    setSubmitting(true);
    try {
      await updateSelfProfile({
        displayName: displayName.trim(),
        phone: phoneDigits || null,
      });
      Alert.alert('Saved', 'Your profile has been updated.');
      router.back();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Edit profile" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}>
        <Card>
          <View style={{ gap: 16 }}>
            <Input
              label="Display name"
              value={displayName}
              onChange={setDisplayName}
              icon="user"
              autoCapitalize="words"
              editable={!submitting}
            />

            <Input
              label="Phone"
              value={phone}
              onChange={(v) => setPhone(formatNgPhone(v))}
              icon="phone"
              keyboardType="phone-pad"
              placeholder="0803 123 4567"
              editable={!submitting}
            />

            <View>
              <Text style={kicker}>Email</Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.textSecondary, marginTop: 6 }}>
                {user.email}
              </Text>
              <Pressable
                onPress={() => router.push('/(profile)/change-email')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Change email"
                style={({ pressed }) => ([
                  { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
                  pressed && { opacity: 0.7 },
                ])}
              >
                <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.black }}>
                  Change email
                </Text>
                <Icon name="arrowRight" size={12} color={colors.black} />
              </Pressable>
            </View>
          </View>
        </Card>

        {error ? (
          <Card>
            <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.red }}>{error}</Text>
          </Card>
        ) : null}

        <Button variant="emphasis" full onPress={save} disabled={!dirty || submitting}>
          {submitting ? <ActivityIndicator color={colors.white} /> : 'Save changes'}
        </Button>
      </ScrollView>
    </View>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
