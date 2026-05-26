import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useRouter } from 'expo-router';
import { useCurrentUser } from '@/hooks/useAuth';
import { useQueue } from '@/queue/QueueProvider';
import { useGuardedSignOut } from '@/queue/useGuardedSignOut';
import { AppBar, Avatar, Button, Card, Icon } from '@/components/ui';
import type { IconName } from '@/components/ui';
import {
  biometricLabel,
  biometricSupported,
  isBiometricEnabled,
  promptBiometric,
  setBiometricEnabled,
} from '@/lib/biometric';
import { resetAllHints } from '@/hints/storage';
import { colors, fonts } from '@/lib/theme';

export function ProfileScreen() {
  const router = useRouter();
  const user = useCurrentUser();
  const signOut = useGuardedSignOut();
  const { snapshot } = useQueue();
  const pending = snapshot.jobs.filter(
    j => j.status === 'pending' || j.status === 'in_flight' || j.status === 'failed_retrying',
  ).length;
  const dead = snapshot.jobs.filter(j => j.status === 'dead_letter').length;

  // Biometric capability + state.
  const [bioSupported, setBioSupported] = useState(false);
  const [bioEnabled, setBioEnabledState] = useState(false);
  const [bioBusy, setBioBusy]            = useState(false);
  const [bioLabelText, setBioLabelText]  = useState('Biometric');

  useEffect(() => {
    (async () => {
      const [sup, on, lbl] = await Promise.all([
        biometricSupported(),
        isBiometricEnabled(),
        biometricLabel(),
      ]);
      setBioSupported(sup);
      setBioEnabledState(on);
      setBioLabelText(lbl);
    })();
  }, []);

  const toggleBiometric = useCallback(async (next: boolean) => {
    if (bioBusy) return;
    setBioBusy(true);
    try {
      if (next) {
        // Confirm with a live biometric prompt before persisting the flag.
        const ok = await promptBiometric(`Enable ${bioLabelText} for Reda`);
        if (!ok) { setBioBusy(false); return; }
        await setBiometricEnabled(true);
        setBioEnabledState(true);
      } else {
        await setBiometricEnabled(false);
        setBioEnabledState(false);
      }
    } finally {
      setBioBusy(false);
    }
  }, [bioBusy, bioLabelText]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Profile" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 32 }}>
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <Avatar user={{ display_name: user.displayName }} size={60} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: fonts.extrabold, fontSize: 18, color: colors.black, letterSpacing: -0.3 }}>
                {user.displayName}
              </Text>
              <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, marginTop: 2, textTransform: 'capitalize' }}>
                {user.role}
              </Text>
              <Text style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textTertiary, marginTop: 2 }}>
                {user.email}
              </Text>
            </View>
          </View>
        </Card>

        {/* Team / internal calling */}
        <Card style={{ padding: 0 }}>
          <ProfileRow
            icon="users"
            label="Team directory"
            value=""
            onPress={() => router.push('/(call)/team')}
            divider
          />
          <ProfileRow
            icon="phone"
            label="Call history"
            value=""
            onPress={() => router.push('/(call)/history')}
            divider
          />
          <ProfileRow
            icon="settings"
            label="Call permissions"
            value="Fix ringing issues"
            onPress={() => {
              Alert.alert(
                'Reda call permissions',
                'For your phone to ring on incoming calls, Reda needs:\n\n' +
                '• Microphone — Allow\n' +
                '• Phone — Allow\n' +
                '• Notifications — Allow (with sound)\n' +
                '• Display over other apps — Allow\n' +
                '• Battery — set to "No restriction" / "Unrestricted"\n\n' +
                'If your phone is a Gionee, Tecno, Xiaomi, Oppo, or similar, also enable "Autostart" or "Allow background activity" so the app stays awake.\n\n' +
                'Tap "Open settings" to go there now.',
                [
                  { text: 'Later', style: 'cancel' },
                  { text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => { /* noop */ }); } },
                ],
              );
            }}
          />
        </Card>

        {/* Account management */}
        <Card style={{ padding: 0 }}>
          <ProfileRow
            icon="edit"
            label="Edit profile"
            value=""
            onPress={() => router.push('/(profile)/edit')}
            divider
          />
          <ProfileRow
            icon="mail"
            label="Change email"
            value=""
            onPress={() => router.push('/(profile)/change-email')}
            divider
          />
          <ProfileRow
            icon="lock"
            label="Change password"
            value=""
            onPress={() => router.push('/(profile)/change-password')}
            divider={bioSupported}
          />
          {bioSupported ? (
            <ToggleRow
              icon="lock"
              label={`Unlock with ${bioLabelText}`}
              value={bioEnabled}
              onChange={toggleBiometric}
              busy={bioBusy}
            />
          ) : null}
        </Card>

        {/* Sync + misc */}
        <Card style={{ padding: 0 }}>
          <ProfileRow
            icon="refresh"
            label="Sync status"
            value={
              snapshot.online
                ? pending > 0
                  ? `${pending} pending`
                  : dead > 0
                    ? `${dead} failed`
                    : 'All synced'
                : 'Offline'
            }
            onPress={
              pending > 0 || dead > 0
                ? () => router.push('/(queue)/dead-letter')
                : undefined
            }
            divider
            valueTone={
              dead > 0 ? 'error' : !snapshot.online ? 'warn' : 'default'
            }
          />
          <ProfileRow icon="bell"   label="Notifications" value="On"          divider />
          <ProfileRow
            icon="helpCircle"
            label="Help & support"
            value=""
            onPress={() => router.push('/(profile)/help')}
            divider
          />
          <ProfileRow
            icon="refresh"
            label="See hints again"
            value=""
            onPress={async () => {
              await resetAllHints(user.userId);
              Alert.alert('Hints reset', 'Tips will reappear as you use the app.');
            }}
            divider
          />
          <AboutRow />
        </Card>

        <Button variant="destructive" full icon="logout" onPress={signOut}>
          Sign out
        </Button>
      </ScrollView>
    </View>
  );
}

function ProfileRow({
  icon, label, value, divider, onPress, valueTone = 'default',
}: {
  icon: IconName;
  label: string;
  value: string;
  divider?: boolean;
  onPress?: () => void;
  valueTone?: 'default' | 'warn' | 'error';
}) {
  const valueColor = valueTone === 'error' ? colors.red
    : valueTone === 'warn' ? colors.warningDark
    : colors.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 16,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        borderBottomWidth: divider ? 1 : 0,
        borderBottomColor: colors.border,
        backgroundColor: pressed && onPress ? colors.surface : colors.white,
      })}
    >
      <Icon name={icon} size={20} color={colors.textSecondary} />
      <Text style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}>{label}</Text>
      {value ? (
        <Text style={{ fontFamily: fonts.medium, fontSize: 13, color: valueColor }}>{value}</Text>
      ) : null}
      {onPress ? <Icon name="chevronRight" size={16} color={colors.textSecondary} /> : null}
    </Pressable>
  );
}

function ToggleRow({
  icon, label, value, onChange, busy,
}: {
  icon: IconName;
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
}) {
  return (
    <View style={{
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.white,
    }}>
      <Icon name={icon} size={20} color={colors.textSecondary} />
      <Text style={{ flex: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}>{label}</Text>
      {busy ? <ActivityIndicator /> : null}
      <Switch value={value} onValueChange={onChange} disabled={busy} />
    </View>
  );
}

function AboutRow() {
  const version = Constants.expoConfig?.version ?? '—';
  const updateId = Updates.updateId ?? null;
  const [checking, setChecking] = useState(false);

  async function checkForUpdates() {
    if (checking) return;
    setChecking(true);
    try {
      const r = await Updates.checkForUpdateAsync();
      if (!r.isAvailable) {
        Alert.alert("You're up to date", `Reda v${version}`);
        return;
      }
      await Updates.fetchUpdateAsync();
      Alert.alert(
        'Update ready',
        'Reda will restart now to apply the update.',
        [{ text: 'Restart', onPress: () => Updates.reloadAsync() }],
      );
    } catch (e) {
      Alert.alert('Could not check', e instanceof Error ? e.message : 'Try again later.');
    } finally {
      setChecking(false);
    }
  }

  const detail = updateId ? `v${version} · ${updateId.slice(0, 8)}` : `v${version}`;

  return (
    <Pressable
      onPress={checkForUpdates}
      style={({ pressed }) => ({
        paddingHorizontal: 16,
        paddingVertical: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        backgroundColor: pressed ? colors.surface : colors.white,
      })}
    >
      <Icon name="file" size={20} color={colors.textSecondary} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontFamily: fonts.semibold, fontSize: 14, color: colors.black }}>About Reda</Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>{detail}</Text>
      </View>
      {checking
        ? <ActivityIndicator />
        : <Text style={{ fontFamily: fonts.semibold, fontSize: 12, color: colors.red }}>Check for updates</Text>}
    </Pressable>
  );
}
