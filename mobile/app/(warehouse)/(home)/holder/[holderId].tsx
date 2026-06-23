import { useLocalSearchParams } from 'expo-router';
import { HolderDetail } from '@/screens/stock/HolderDetail';

export default function WarehouseHolderStockDetail() {
  const { holderId } = useLocalSearchParams<{ holderId: string }>();
  if (!holderId) return null;
  return <HolderDetail holderId={holderId} basePath="/(warehouse)" />;
}
