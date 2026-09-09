import { useLocalSearchParams } from 'expo-router';
import { Movements } from '@/screens/stock/Movements';

export default function AdminStockMovements() {
  // productId is optional — set when arriving from a product row on the holder's detail.
  const { holderId, productId } = useLocalSearchParams<{ holderId: string; productId?: string }>();
  if (!holderId) return null;
  return <Movements holderId={holderId} basePath="/(admin)" initialProductId={productId ?? null} />;
}
