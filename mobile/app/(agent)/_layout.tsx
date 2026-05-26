import { Tabs } from 'expo-router';
import { Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { RedaTabBar } from '@/queue/RedaTabBar';

export default function AgentLayout() {
  return (
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
          tabBarIcon: ({ color, focused }) => <Icon name="home" size={22} color={color} stroke={focused ? 2.2 : 1.75} />,
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{
          title: 'My stock',
          tabBarIcon: ({ color, focused }) => <Icon name="package" size={22} color={color} stroke={focused ? 2.2 : 1.75} />,
        }}
      />
      <Tabs.Screen
        name="earnings"
        options={{
          title: 'Earnings',
          tabBarIcon: ({ color, focused }) => <Icon name="wallet" size={22} color={color} stroke={focused ? 2.2 : 1.75} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused }) => <Icon name="user" size={22} color={color} stroke={focused ? 2.2 : 1.75} />,
        }}
      />
    </Tabs>
  );
}
