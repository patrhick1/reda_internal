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
      {/* The "Stock" tab is a nested Stack (the (home) group): the dashboard
          plus the Transfer / Receive / Adjust / Movements screens pushed on
          top. Stacking them — rather than mounting each as a hidden
          tab route — is what lets `router.back()` dismiss an action screen
          after a submit settles, so a successful Transfer no longer leaves the
          button spinning. */}
      <Tabs.Screen
        name="(home)"
        options={{
          title: 'Stock',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="warehouse" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      {/* Available orders is the warehouse's main planning surface, so it
          stands alone as a tab (2026-09-09) instead of a card on the Stock
          dashboard. Warehouse-only — admin/dispatcher keep their own entry
          points. Its own Stack holds the per-agent drilldown. */}
      <Tabs.Screen
        name="available"
        options={{
          title: 'Available',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="truck" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
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
    </Tabs>
  );
}
