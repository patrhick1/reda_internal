import { useLocalSearchParams } from 'expo-router';
import { useCurrentUser } from '@/hooks/useAuth';
import { Movements } from '@/screens/stock/Movements';

export default function AgentMovements() {
  const user = useCurrentUser();
  // Optional — set when arriving from a product row on My stock, so the history
  // opens already tracing that product.
  const { productId } = useLocalSearchParams<{ productId?: string }>();
  return (
    <Movements holderId={user.userId} basePath="/(agent)" initialProductId={productId ?? null} />
  );
}
