import { useLocalSearchParams } from 'expo-router';
import { CountHistory } from '@/screens/stock/CountHistory';

export default function DispatcherCountHistory() {
  // Optional — set when arriving from a holder's detail screen.
  const { holderId, weekEnding } = useLocalSearchParams<{
    holderId?: string;
    weekEnding?: string;
  }>();
  return (
    <CountHistory
      basePath="/(dispatcher)"
      initialHolderId={holderId ?? null}
      weekEnding={weekEnding ?? null}
    />
  );
}
