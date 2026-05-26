import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';

const KEY = 'reda.biometric.enabled';

export async function isBiometricEnabled(): Promise<boolean> {
  const v = await AsyncStorage.getItem(KEY);
  return v === 'true';
}

export async function setBiometricEnabled(on: boolean): Promise<void> {
  if (on) await AsyncStorage.setItem(KEY, 'true');
  else    await AsyncStorage.removeItem(KEY);
}

/** True when the device has biometric hardware AND the user has enrolled
 *  at least one (Face ID, Touch ID, fingerprint). False otherwise — and on
 *  any error, we treat it as unavailable rather than throwing. */
export async function biometricSupported(): Promise<boolean> {
  try {
    const [hasHw, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHw && enrolled;
  } catch {
    return false;
  }
}

/** Returns a short label like "Face ID" / "Touch ID" / "Biometric" for UI. */
export async function biometricLabel(): Promise<string> {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'Face ID';
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT))        return 'Fingerprint';
    if (types.includes(LocalAuthentication.AuthenticationType.IRIS))               return 'Iris';
    return 'Biometric';
  } catch {
    return 'Biometric';
  }
}

export async function promptBiometric(reason = 'Unlock Reda'): Promise<boolean> {
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return res.success;
  } catch {
    return false;
  }
}
