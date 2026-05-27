import { useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { AppBar, Card, Icon, SectionHeader } from '@/components/ui';
import { colors, fonts } from '@/lib/theme';
import { Text } from 'react-native';
import type { IconName } from '@/components/ui';

const SECTIONS: {
  href:
    | '/(admin)/catalog/clients'
    | '/(admin)/catalog/locations'
    | '/(admin)/catalog/products'
    | '/(admin)/catalog/rates'
    | '/(admin)/catalog/users';
  icon: IconName;
  title: string;
  sub: string;
}[] = [
  {
    href: '/(admin)/catalog/clients',
    icon: 'users',
    title: 'Clients',
    sub: 'Vendors Reda delivers for',
  },
  {
    href: '/(admin)/catalog/locations',
    icon: 'mapPin',
    title: 'Locations',
    sub: 'Delivery zones + aliases for AI matching',
  },
  {
    href: '/(admin)/catalog/products',
    icon: 'box',
    title: 'Products',
    sub: 'What each client sells (client × name pair)',
  },
  {
    href: '/(admin)/catalog/rates',
    icon: 'wallet',
    title: 'Rate card',
    sub: 'What Reda charges + what the agent earns, per location',
  },
  {
    href: '/(admin)/catalog/users',
    icon: 'user',
    title: 'Users',
    sub: 'Admins, dispatchers, agents, warehouse',
  },
];

export default function CatalogHome() {
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar title="Catalog" subtitle="Set up the world Reda operates in" />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        <SectionHeader>Pick a section</SectionHeader>
        {SECTIONS.map((s) => (
          <Card key={s.href} dense onPress={() => router.push(s.href)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  backgroundColor: colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name={s.icon} size={20} color={colors.black} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.black }}>
                  {s.title}
                </Text>
                <Text
                  style={{
                    fontFamily: fonts.medium,
                    fontSize: 12,
                    color: colors.textSecondary,
                    marginTop: 2,
                  }}
                >
                  {s.sub}
                </Text>
              </View>
              <Icon name="chevronRight" size={18} color={colors.textSecondary} />
            </View>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
