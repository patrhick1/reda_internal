import { Tabs } from 'expo-router';
import { Icon } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { RedaTabBar } from '@/queue/RedaTabBar';
import { useNeedsReviewCount } from '@/hooks/useNeedsReviewCount';

export default function AdminLayout() {
  const needsReviewCount = useNeedsReviewCount();
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
          title: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="home" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      <Tabs.Screen
        name="deliveries"
        options={{
          title: 'Deliveries',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="truck" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      <Tabs.Screen
        name="reconcile"
        options={{
          title: 'Reconcile',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="wallet" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      <Tabs.Screen
        name="needs-review"
        options={{
          title: 'Review',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="alert" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
          tabBarBadge: needsReviewCount > 0 ? needsReviewCount : undefined,
          tabBarBadgeStyle: {
            backgroundColor: colors.red,
            color: colors.white,
            fontFamily: fonts.bold,
            fontSize: 11,
            minWidth: 18,
            height: 18,
            lineHeight: 18,
          },
        }}
      />
      <Tabs.Screen
        name="catalog"
        options={{
          title: 'Catalog',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="box" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{
          title: 'Stock',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="warehouse" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
          href: null,
        }}
      />
      <Tabs.Screen
        name="eod"
        options={{
          title: 'EOD',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="calendar" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
          href: null,
        }}
      />
      <Tabs.Screen
        name="flags"
        options={{
          title: 'Flags',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="sliders" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
          href: null,
        }}
      />
      <Tabs.Screen
        name="location-approvals"
        options={{
          title: 'Approvals',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="mapPin" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
          href: null,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="settings" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
          href: null,
        }}
      />
      <Tabs.Screen
        name="rep-performance"
        options={{
          title: 'Rep performance',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="users" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
          href: null,
        }}
      />
    </Tabs>
  );
}
