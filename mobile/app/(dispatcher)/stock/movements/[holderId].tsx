import { useLocalSearchParams } from 'expo-router';
import { Movements } from '@/screens/stock/Movements';

export default function DispatcherStockMovements() {
  const { holderId } = useLocalSearchParams<{ holderId: string }>();
  if (!holderId) return null;
  return <Movements holderId={holderId} basePath="/(dispatcher)" />;
}
