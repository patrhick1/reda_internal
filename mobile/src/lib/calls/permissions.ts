import { Platform, PermissionsAndroid } from 'react-native';

// RECORD_AUDIO is a runtime-grant "dangerous" permission on Android 6+,
// even though we declare it in AndroidManifest. iOS handles mic via NSUsage
// strings + the system prompt the first time Agora tries to use the mic.

export async function ensureMicPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const status = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (status) return true;
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: 'Microphone for calls',
        message: 'Reda needs the microphone so you can talk to your teammates during a call.',
        buttonPositive: 'Allow',
        buttonNegative: 'Not now',
      },
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch (err) {
    console.warn('[perms] mic check failed', err);
    return false;
  }
}
