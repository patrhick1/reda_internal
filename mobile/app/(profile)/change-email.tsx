import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { changeMyEmail } from '@/services/users';
import { useCurrentUser } from '@/hooks/useAuth';
import { AppBar, Button, Card, Icon, Input } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ChangeEmailScreen() {
  const router = useRouter();
  const user = useCurrentUser();
  const [password, setPassword]   = useState('');
  const [next, setNext]           = useState('');
  const [confirm, setConfirm]     = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting]     = useState(false);
  const [error, setError]               = useState<string | null>(null);

  const trimmedNext    = next.trim().toLowerCase();
  const trimmedConfirm = confirm.trim().toLowerCase();
  const validNew  = EMAIL_RE.test(trimmedNext);
  const matches   = trimmedNext === trimmedConfirm;
  const notSame   = trimmedNext !== user.email.toLowerCase();
  const canSubmit = !!password && validNew && matches && notSame && !submitting;

  async function save() {
    setError(null);
    if (!validNew) { setError('Enter a valid email address'); return; }
    if (!matches)  { setError('New email and confirmation do not match'); return; }
    if (!notSame)  { setError('That is already your email'); return; }
    setSubmitting(true);
    try {
      await changeMyEmail(password, trimmedNext);
      Alert.alert(
        'Check your inbox',
        `We sent a confirmation link to ${trimmedNext}. Open it from that inbox to finish the change. Your login email won't update until you confirm.`,
      );
      router.back();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Change email" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}>
        <Card>
          <View style={{ gap: 16 }}>
            <View>
              <Text style={kicker}>Current email</Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.textSecondary, marginTop: 6 }}>
                {user.email}
              </Text>
            </View>
            <Input
              label="Current password"
              value={password}
              onChange={setPassword}
              icon="lock"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoComplete="password"
              editable={!submitting}
              rightAdornment={<EyeToggle on={showPassword} onPress={() => setShowPassword((v) => !v)} />}
            />
            <Input
              label="New email"
              value={next}
              onChange={setNext}
              icon="mail"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              editable={!submitting}
              error={next.length > 0 && !validNew ? 'Enter a valid email address' : null}
            />
            <Input
              label="Confirm new email"
              value={confirm}
              onChange={setConfirm}
              icon="mail"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              editable={!submitting}
              error={confirm.length > 0 && !matches ? 'Does not match' : null}
            />
          </View>
        </Card>

        {error ? (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="alert" size={16} color={colors.red} />
              <Text style={{ flex: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.red }}>
                {error}
              </Text>
            </View>
          </Card>
        ) : null}

        <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, lineHeight: 18 }}>
          We'll send a confirmation link to the new address. Your login email
          won't update until you click that link, so make sure you can open
          that inbox first.
        </Text>

        <Button variant="emphasis" full onPress={save} disabled={!canSubmit}>
          {submitting ? <ActivityIndicator color={colors.white} /> : 'Send confirmation link'}
        </Button>
      </ScrollView>
    </View>
  );
}

function EyeToggle({ on, onPress }: { on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityLabel={on ? 'Hide password' : 'Show password'}>
      <Icon name={on ? 'eyeOff' : 'eye'} size={18} color={colors.textSecondary} />
    </Pressable>
  );
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
