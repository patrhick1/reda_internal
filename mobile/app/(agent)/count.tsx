import { View } from 'react-native';
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { AppBar } from '@/components/ui';
import { StockCountScreen } from '@/screens/stock/Count';
import { useReloadOnFocus } from '@/hooks/useReloadOnFocus';

export default function AgentCount() {
  const router = useRouter();
  const [visit, setVisit] = useState(0);
  // Hidden tab routes stay mounted: each new visit must start a fresh count,
  // rather than reopening the receipt from the previous submission.
  useReloadOnFocus(() => setVisit((value) => value + 1));
  return (
    <View style={{ flex: 1 }}>
      <AppBar title="Count stock" onBack={() => router.replace('/(agent)/stock')} />
      <StockCountScreen key={visit} scope="agent" />
    </View>
  );
}
