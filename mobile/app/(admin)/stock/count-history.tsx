import { useLocalSearchParams } from 'expo-router';
import { CountHistory } from '@/screens/stock/CountHistory';

export default function AdminCountHistory() {
  // Optional — set when arriving from a holder's detail screen.
  const { holderId } = useLocalSearchParams<{ holderId?: string }>();
  return <CountHistory basePath="/(admin)" initialHolderId={holderId ?? null} />;
}
