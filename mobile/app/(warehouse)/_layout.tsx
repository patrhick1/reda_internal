import { Tabs } from 'expo-router';
import { Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { RedaTabBar } from '@/queue/RedaTabBar';

export default function WarehouseLayout() {
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
      <Tabs.Screen
        name="index"
        options={{
          title: 'Stock',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="warehouse" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
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
      {/* Action screens — pushed from the Stock dashboard, never shown in
          the tab bar. Each re-exports the shared screen with scope='warehouse'
          which locks the holder side to the caller server-side. */}
      <Tabs.Screen name="receive" options={{ href: null }} />
      <Tabs.Screen name="transfer" options={{ href: null }} />
      <Tabs.Screen name="adjust" options={{ href: null }} />
      {/* Available orders — shared dispatcher+warehouse view, entered via
          the card on the Stock home. Read-only here (no /deliveries route
          in this group, so order rows are non-tappable). */}
      <Tabs.Screen name="available" options={{ href: null }} />
    </Tabs>
  );
}
