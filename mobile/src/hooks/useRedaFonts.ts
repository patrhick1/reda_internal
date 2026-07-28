import { useEffect, useState } from 'react';
import { useFonts } from 'expo-font';
import { Montserrat_400Regular } from '@expo-google-fonts/montserrat/400Regular';
import { Montserrat_500Medium } from '@expo-google-fonts/montserrat/500Medium';
import { Montserrat_600SemiBold } from '@expo-google-fonts/montserrat/600SemiBold';
import { Montserrat_700Bold } from '@expo-google-fonts/montserrat/700Bold';
import { Montserrat_800ExtraBold } from '@expo-google-fonts/montserrat/800ExtraBold';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono/500Medium';

// Fonts improve the presentation, but they must never make the operational app
// unusable. On a cold OTA launch, an asset-cache or slow-device issue used to
// leave the whole app behind the startup spinner forever because useFonts'
// error value was ignored. Continue with the platform fallback after a short
// grace period; expo-font can still finish loading and swap the custom fonts in.
const FONT_STARTUP_GRACE_MS = 2500;

export function useRedaFonts(): boolean {
  const [loaded, error] = useFonts({
    Montserrat_400Regular,
    Montserrat_500Medium,
    Montserrat_600SemiBold,
    Montserrat_700Bold,
    Montserrat_800ExtraBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (loaded || error) return;
    const timeout = setTimeout(() => setTimedOut(true), FONT_STARTUP_GRACE_MS);
    return () => clearTimeout(timeout);
  }, [loaded, error]);

  useEffect(() => {
    if (error) console.warn('[fonts] Custom fonts failed to load; using system fonts', error);
  }, [error]);

  return loaded || Boolean(error) || timedOut;
}
