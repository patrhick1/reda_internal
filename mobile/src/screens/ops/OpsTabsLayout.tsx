// Tab-bar configuration shared by the dispatcher and rep route groups.
// Both roles get the same 4 tabs (Dashboard / Deliveries / Review / Profile)
// — no stock tab, since neither role has stock access.
import { Tabs } from 'expo-router';
import { Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { RedaTabBar } from '@/queue/RedaTabBar';

export function OpsTabsLayout() {
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
      <Tabs.Screen name="index"      options={{ title: 'Dashboard',  tabBarIcon: ({ color, focused }) => <Icon name="home"  size={22} color={color} stroke={focused ? 2.2 : 1.75} /> }} />
      <Tabs.Screen name="deliveries" options={{ title: 'Deliveries', tabBarIcon: ({ color, focused }) => <Icon name="truck" size={22} color={color} stroke={focused ? 2.2 : 1.75} /> }} />
      <Tabs.Screen name="review"     options={{ title: 'Review',     tabBarIcon: ({ color, focused }) => <Icon name="alert" size={22} color={color} stroke={focused ? 2.2 : 1.75} /> }} />
      <Tabs.Screen name="profile"    options={{ title: 'Profile',    tabBarIcon: ({ color, focused }) => <Icon name="user"  size={22} color={color} stroke={focused ? 2.2 : 1.75} /> }} />
    </Tabs>
  );
}
