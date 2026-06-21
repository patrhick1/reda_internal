// Tab-bar configuration shared by the dispatcher and rep route groups.
// Dispatchers get Dashboard / Deliveries / Review / Profile (plus a hidden
// Stock route entered from the dashboard Quick action). Reps get only
// Dashboard / Deliveries / Profile — the needs-review queue is manager-only
// per Uzo (2026-06-10), so reps neither see the Review tab nor declare the
// (rep)/review directory (it was removed). Reps remain stockless.
import { Tabs } from 'expo-router';
import { Icon } from '@/components/ui';
import { useCurrentUser } from '@/hooks/useAuth';
import { colors, fonts } from '@/lib/theme';
import { RedaTabBar } from '@/queue/RedaTabBar';
import { useNeedsReviewCount } from '@/hooks/useNeedsReviewCount';

export function OpsTabsLayout() {
  const user = useCurrentUser();
  const showStock = user.role === 'dispatcher';
  // Zone-change approvals are manager-only; among ops that's dispatcher (admin
  // has its own group). Reps must NOT declare it (no matching directory).
  const showApprovals = user.role === 'dispatcher';
  // Review queue is manager-only; reps don't declare a (rep)/review directory.
  const showReview = user.role !== 'rep';
  // Reps get a fee-free client-reconcile tab to send delivered-updates. Only
  // the (rep) group declares a reconcile directory, so the tab is rep-only —
  // declaring it for dispatchers would demand a (dispatcher)/reconcile route.
  const showReconcile = user.role === 'rep';
  const needsReviewCount = useNeedsReviewCount(showReview);
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
      {showReview ? (
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
      ) : null}
      {showReconcile ? (
        <Tabs.Screen
          name="reconcile"
          options={{
            title: 'Reconcile',
            tabBarIcon: ({ color, focused }) => (
              <Icon name="wallet" size={22} color={color} stroke={focused ? 2.2 : 1.75} />
            ),
          }}
        />
      ) : null}
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
      {showApprovals ? (
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
      ) : null}
    </Tabs>
  );
}
