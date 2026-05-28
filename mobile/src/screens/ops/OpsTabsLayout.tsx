// Tab-bar configuration shared by the dispatcher and rep route groups.
// Both roles get the same 4 visible tabs (Dashboard / Deliveries / Review /
// Profile). Dispatchers additionally have a hidden Stock route (no tab in
// the bar — entered from the dashboard Quick action) so they can monitor
// inventory; reps remain stockless.
import { Tabs } from 'expo-router';
import { Icon } from '@/components/ui';
import { useCurrentUser } from '@/hooks/useAuth';
import { colors, fonts } from '@/lib/theme';
import { RedaTabBar } from '@/queue/RedaTabBar';
import { useNeedsReviewCount } from '@/hooks/useNeedsReviewCount';

export function OpsTabsLayout() {
  const needsReviewCount = useNeedsReviewCount();
  const user = useCurrentUser();
  const showStock = user.role === 'dispatcher';
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
          title: 'Dashboard',
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
        name="review"
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
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused }) => (
            <Icon name="user" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
          ),
        }}
      />
      {/* Hidden routes: declared only for dispatchers so expo-router accepts
          the (dispatcher)/stock and (dispatcher)/available directories
          without surfacing them in the tab bar. Reps must NOT declare these
          — they have no matching directories. */}
      {showStock ? (
        <>
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
            name="available"
            options={{
              title: 'Available',
              tabBarIcon: ({ color, focused }) => (
                <Icon name="truck" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
              ),
              href: null,
            }}
          />
        </>
      ) : null}
    </Tabs>
  );
}
