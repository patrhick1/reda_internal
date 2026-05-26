import { View } from 'react-native';
import { BottomTabBar, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/lib/theme';
import { QueueBanner } from './QueueBanner';

/**
 * Drop-in `tabBar` for expo-router's <Tabs> that stacks the queue/network
 * banner above the default tab bar. Used by every role's layout so the banner
 * appears consistently above the bottom strip without leaking into screen
 * scroll behaviour.
 */
export function RedaTabBar(props: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: colors.white, paddingBottom: insets.bottom }}>
      <QueueBanner />
      <BottomTabBar {...props} />
    </View>
  );
}
