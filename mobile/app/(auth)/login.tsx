import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@/hooks/useAuth';
import { sendPasswordReset } from '@/services/users';
import { Button, Icon, Input, RedaMark } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';

const REMEMBER_EMAIL_KEY = 'reda.login.lastEmail';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotSubmitting, setForgotSubmitting] = useState(false);

  // Pre-fill last-used email on mount.
  useEffect(() => {
    AsyncStorage.getItem(REMEMBER_EMAIL_KEY).then((v) => {
      if (v) setEmail(v);
    });
  }, []);

  async function handleSubmit() {
    if (!email || !password) {
      setError('Email and password required');
      return;
    }
    setSubmitting(true);
    setError(null);
    const normalizedEmail = email.trim().toLowerCase();
    const { error: err } = await signIn(normalizedEmail, password);
    if (err) {
      setError(friendlyError(err));
      setSubmitting(false);
      return;
    }
    AsyncStorage.setItem(REMEMBER_EMAIL_KEY, normalizedEmail).catch(() => { /* non-fatal */ });
    // success: AuthGate routes us away from this screen.
  }

  async function handleForgot() {
    const target = (forgotEmail || email).trim().toLowerCase();
    if (!target) {
      Alert.alert('Email required', 'Enter the email you sign in with.');
      return;
    }
    setForgotSubmitting(true);
    try {
      await sendPasswordReset(target);
      Alert.alert(
        'Reset link sent',
        `If an account exists for ${target}, you'll get an email with a link to set a new password.`,
      );
      setForgotOpen(false);
      setForgotEmail('');
    } catch (e) {
      Alert.alert('Could not send', e instanceof Error ? e.message : 'Try again in a moment.');
    } finally {
      setForgotSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.black }}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Brand block */}
        <View style={{ paddingHorizontal: 24, paddingTop: 80, paddingBottom: 32, flex: 1, justifyContent: 'flex-end' }}>
          <RedaMark size={64} inverted />
          <Text style={{
            color: colors.white,
            fontFamily: fonts.extrabold,
            fontSize: 32,
            letterSpacing: -0.8,
            lineHeight: 36,
            marginTop: 24,
          }}>
            Fast. Reliable.{'\n'}
            <Text style={{ color: colors.red }}>Last mile, done right.</Text>
          </Text>
          <Text style={{
            color: colors.textTertiary,
            fontFamily: fonts.medium,
            fontSize: 14,
            lineHeight: 21,
            marginTop: 12,
            maxWidth: 280,
          }}>
            Reda internal team app — log in to manage today&apos;s deliveries.
          </Text>
        </View>

        {/* Sign-in card */}
        <View style={{
          backgroundColor: colors.white,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          paddingHorizontal: 20,
          paddingTop: 24,
          paddingBottom: 28,
        }}>
          <Text style={{
            fontFamily: fonts.bold,
            fontSize: 13,
            color: colors.textSecondary,
            letterSpacing: 0.8,
            textTransform: 'uppercase',
            marginBottom: 16,
          }}>
            Sign in
          </Text>

          <View style={{ gap: 16 }}>
            <Input
              label="Email"
              value={email}
              onChange={setEmail}
              icon="user"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              editable={!submitting}
            />
            <Input
              label="Password"
              value={password}
              onChange={setPassword}
              icon="lock"
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              autoComplete="password"
              editable={!submitting}
              error={error}
              rightAdornment={
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  hitSlop={8}
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} color={colors.textSecondary} />
                </Pressable>
              }
            />

            <Pressable
              onPress={() => { setForgotOpen((v) => !v); setForgotEmail(email); }}
              hitSlop={6}
            >
              <Text style={{
                fontFamily: fonts.semibold,
                fontSize: 13,
                color: colors.red,
                alignSelf: 'flex-end',
                marginTop: -4,
              }}>
                Forgot password?
              </Text>
            </Pressable>

            {forgotOpen ? (
              <View style={{
                backgroundColor: colors.surface,
                padding: 12,
                borderRadius: 10,
                gap: 10,
              }}>
                <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, lineHeight: 17 }}>
                  Enter your email and we&apos;ll send a reset link.
                </Text>
                <Input
                  value={forgotEmail}
                  onChange={setForgotEmail}
                  icon="user"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType="email-address"
                  editable={!forgotSubmitting}
                  placeholder="you@example.com"
                />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Button variant="secondary" full onPress={() => setForgotOpen(false)} disabled={forgotSubmitting}>
                      Cancel
                    </Button>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button variant="emphasis" full onPress={handleForgot} disabled={forgotSubmitting}>
                      {forgotSubmitting ? <ActivityIndicator color={colors.white} /> : 'Send link'}
                    </Button>
                  </View>
                </View>
              </View>
            ) : null}
          </View>

          <View style={{ marginTop: 18 }}>
            <Button variant="emphasis" full onPress={handleSubmit} disabled={submitting}>
              {submitting ? <ActivityIndicator color={colors.white} /> : 'Sign in'}
            </Button>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function friendlyError(err: string): string {
  const lower = err.toLowerCase();
  if (lower.includes('invalid login') || lower.includes('invalid_credentials')) {
    return 'Invalid email or password';
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Too many attempts. Try again in a few minutes.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Email not confirmed. Contact your admin.';
  }
  if (lower.includes('network') || lower.includes('fetch')) {
    return 'Cannot connect — check your connection';
  }
  return err;
}
