import { useLocalSearchParams } from 'expo-router';
import { GlobalMovements } from '@/screens/stock/GlobalMovements';

export default function AdminClientMovements() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  if (!id) return null;
  return <GlobalMovements basePath="/(admin)" clientId={id} clientName={name} />;
}
