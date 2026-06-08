import { useCurrentUser } from '@/hooks/useAuth';
import { Movements } from '@/screens/stock/Movements';

export default function AgentMovements() {
  const user = useCurrentUser();
  return <Movements holderId={user.userId} basePath="/(agent)" />;
}
