import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { changeMyPassword } from '@/services/users';
import { AppBar, Button, Card, Icon, Input } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { errorMessage } from '@/lib/errors';

export default function ChangePasswordScreen() {
  const router = useRouter();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext]       = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validNew     = next.length >= 8;
  const matches      = next === confirm;
  const canSubmit    = !!current && validNew && matches && !submitting;

  async function save() {
    setError(null);
    if (!validNew) { setError('New password must be at least 8 characters'); return; }
    if (!matches)  { setError('New password and confirmation do not match'); return; }
    setSubmitting(true);
    try {
      await changeMyPassword(current, next);
      Alert.alert('Password updated', 'Use your new password next time you sign in.');
      router.back();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Change password" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}>
        <Card>
          <View style={{ gap: 16 }}>
            <Input
              label="Current password"
              value={current}
              onChange={setCurrent}
              icon="lock"
              secureTextEntry={!showCurrent}
              autoCapitalize="none"
              autoComplete="password"
              editable={!submitting}
              rightAdornment={<EyeToggle on={showCurrent} onPress={() => setShowCurrent((v) => !v)} />}
            />
            <Input
              label="New password"
              value={next}
              onChange={setNext}
              icon="lock"
              secureTextEntry={!showNext}
              autoCapitalize="none"
              autoComplete="new-password"
              editable={!submitting}
              helper={validNew || next.length === 0 ? 'At least 8 characters' : undefined}
              error={next.length > 0 && !validNew ? 'At least 8 characters' : null}
              rightAdornment={<EyeToggle on={showNext} onPress={() => setShowNext((v) => !v)} />}
            />
            <Input
              label="Confirm new password"
              value={confirm}
              onChange={setConfirm}
              icon="lock"
              secureTextEntry={!showConfirm}
              autoCapitalize="none"
              autoComplete="new-password"
              editable={!submitting}
              error={confirm.length > 0 && !matches ? 'Does not match' : null}
              rightAdornment={<EyeToggle on={showConfirm} onPress={() => setShowConfirm((v) => !v)} />}
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

        <Button variant="emphasis" full onPress={save} disabled={!canSubmit}>
          {submitting ? <ActivityIndicator color={colors.white} /> : 'Update password'}
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

