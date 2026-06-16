import { Tabs } from 'expo-router';
import { Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { RedaTabBar } from '@/queue/RedaTabBar';
import {
  AgentUnreadProvider,
  useAgentUnreadMessagesData,
} from '@/hooks/useAgentUnreadMessages';

export default function AgentLayout() {
  // One subscription for the whole agent shell: drives the Today tab badge here
  // and the per-row dots in the Today screen (via AgentUnreadProvider).
  const unread = useAgentUnreadMessagesData(true);
  return (
    <AgentUnreadProvider value={unread}>
    <Tabs
      tabBar={(props) => <RedaTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.black,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor: colors.border,
          height: 64,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarLabelStyle: { fontFamily: fonts.semibold, fontSize: 11 },
      }}
    >
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen
        name="today"
        options={{
          title: 'Today',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="home" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
          tabBarBadge: unread.total > 0 ? (unread.total > 99 ? 99 : unread.total) : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.red, color: colors.white, fontSize: 10 },
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{
          title: 'My stock',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="package" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      <Tabs.Screen
        name="earnings"
        options={{
          title: 'Earnings',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="wallet" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="user" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      {/* Stock movement history — pushed from the "history" icon on My
          stock. Agent's view is always own holder; the server RPC enforces. */}
      <Tabs.Screen name="movements" options={{ href: null }} />
    </Tabs>
    </AgentUnreadProvider>
  );
}
