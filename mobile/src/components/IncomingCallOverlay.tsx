import { useEffect, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, Vibration, Platform, Alert, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar, Icon } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/lib/theme';
import * as coord from '@/lib/calls/coordinator';
import { ensureMicPermission } from '@/lib/calls/permissions';

// Fallback in-app ring UI. Always mounted at root; visible only when the
// coordinator is in 'incoming' phase. On devices where CallKeep's system
// ring UI works (stock Android, Samsung One UI, Pixel), this overlay is
// hidden underneath the system UI and the user never sees it. On hostile
// OEMs (Gionee, Xiaomi, Oppo, Huawei, Vivo) where ConnectionService is
// suppressed, this is the entire ring experience.
//
// Both this overlay's Accept/Decline and CallKeep's events route through
// the same coordinator functions, so there's no double-handling.

// Continuous vibration pattern: 1s buzz, 1s gap, repeat. Looped via second
// arg `true` (Android). iOS ignores the loop flag — Vibration.cancel() must
// be called explicitly when the user acts.
const VIBRATION_PATTERN = [0, 1000, 1000];

export function IncomingCallOverlay() {
  const insets = useSafeAreaInsets();
  const [snap, setSnap] = useState(coord.getSnapshot());
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);

  useEffect(() => coord.subscribe(setSnap), []);

  const isOpen = snap.callId !== null;

  // Vibration loop — start when overlay opens, cancel when it closes OR when
  // the user has tapped a button (so they don't keep buzzing while the
  // RPC + Agora handshake settles).
  useEffect(() => {
    if (!isOpen || busy) {
      Vibration.cancel();
      return;
    }
    Vibration.vibrate(VIBRATION_PATTERN, true);
    return () => { Vibration.cancel(); };
  }, [isOpen, busy]);

  // Reset busy state when the call goes away (accept/decline succeeded or
  // the row was externally dismissed). Otherwise the loading spinner could
  // stick on the last ring after dismissal.
  useEffect(() => {
    if (!isOpen) setBusy(null);
  }, [isOpen]);

  if (!isOpen || !snap.callId) return null;

  const callId = snap.callId;

  const onAccept = async () => {
    if (busy) return;
    setBusy('accept');
    // Mic gate up-front so the user gets a clear "Open settings" path if
    // it's denied, instead of the coordinator silently auto-declining.
    const micOk = await ensureMicPermission();
    if (!micOk) {
      setBusy(null);
      Alert.alert(
        'Microphone needed',
        'Reda needs microphone permission to take this call. Tap "Open settings" → Permissions → Microphone → Allow, then ask them to call again.',
        [
          { text: 'Decline call', style: 'destructive', onPress: () => coord.declineFromOverlay(callId) },
          { text: 'Open settings', onPress: () => { Linking.openSettings().catch(() => { /* noop */ }); coord.declineFromOverlay(callId); } },
        ],
      );
      return;
    }
    try {
      await coord.answer(callId);
    } catch {
      setBusy(null);
    }
  };

  const onDecline = async () => {
    if (busy) return;
    setBusy('decline');
    try {
      await coord.declineFromOverlay(callId);
    } catch {
      setBusy(null);
    }
  };

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onDecline}
    >
      <View style={{
        flex: 1,
        backgroundColor: colors.black,
        paddingTop:    insets.top    + spacing['3xl'],
        paddingBottom: insets.bottom + spacing['3xl'] + 16,
        paddingHorizontal: spacing['3xl'],
      }}>
        {/* Caller block — centered vertically */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing['2xl'] }}>
          <Text style={{
            fontFamily: fonts.semibold, fontSize: 14,
            color: colors.textTertiary, letterSpacing: 1,
            textTransform: 'uppercase',
          }}>
            Incoming Reda call
          </Text>
          <Avatar user={{ display_name: snap.callerName }} size={140} />
          <Text style={{
            fontFamily: fonts.bold, fontSize: 32, color: colors.white,
            textAlign: 'center',
          }}>
            {snap.callerName || 'Reda team'}
          </Text>
          <Text style={{
            fontFamily: fonts.regular, fontSize: 16, color: colors.textTertiary,
          }}>
            {busy === 'accept' ? 'Connecting…'
             : busy === 'decline' ? 'Declining…'
             : 'is calling you'}
          </Text>
        </View>

        {/* Action row */}
        <View style={{
          flexDirection: 'row', justifyContent: 'space-evenly',
          alignItems: 'center', gap: spacing['3xl'],
        }}>
          <ActionButton
            icon="phoneOff"
            label="Decline"
            color={colors.red}
            onPress={onDecline}
            disabled={busy !== null}
            spinning={busy === 'decline'}
          />
          <ActionButton
            icon="phone"
            label="Accept"
            color={colors.success}
            onPress={onAccept}
            disabled={busy !== null}
            spinning={busy === 'accept'}
          />
        </View>
      </View>
    </Modal>
  );
}

function ActionButton({
  icon, label, color, onPress, disabled, spinning,
}: {
  icon: 'phone' | 'phoneOff';
  label: string;
  color: string;
  onPress: () => void;
  disabled: boolean;
  spinning: boolean;
}) {
  return (
    <View style={{ alignItems: 'center', gap: spacing.md }}>
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled}
        activeOpacity={0.7}
        style={{
          width: 80, height: 80, borderRadius: 40,
          backgroundColor: color,
          alignItems: 'center', justifyContent: 'center',
          opacity: disabled && !spinning ? 0.5 : 1,
          transform: [{ rotate: spinning ? '0deg' : (Platform.OS === 'ios' ? '0deg' : '0deg') }],
        }}
      >
        <Icon name={icon} size={36} color={colors.white} />
      </TouchableOpacity>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.white }}>
        {label}
      </Text>
    </View>
  );
}

// Re-export for the inevitable Phase H+ enhancements (ringtone audio, custom
// avatars, etc.) without changing import sites.
export const __overlayInternals = { VIBRATION_PATTERN, radii };
