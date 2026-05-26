import { Stack } from 'expo-router';
import { colors, fonts } from '@/lib/theme';

const headerStyle = {
  headerStyle: { backgroundColor: colors.white },
  headerTintColor: colors.black,
  headerTitleStyle: { fontFamily: fonts.bold, fontSize: 16 },
} as const;

export default function CatalogLayout() {
  return (
    <Stack screenOptions={headerStyle}>
      <Stack.Screen name="index" options={{ headerShown: false }} />

      <Stack.Screen name="clients/index" options={{ title: 'Clients' }} />
      <Stack.Screen name="clients/new"   options={{ title: 'New client', presentation: 'modal' }} />
      <Stack.Screen name="clients/[id]"  options={{ title: 'Edit client' }} />

      <Stack.Screen name="locations/index" options={{ title: 'Locations' }} />
      <Stack.Screen name="locations/new"   options={{ title: 'New location', presentation: 'modal' }} />
      <Stack.Screen name="locations/[id]"  options={{ title: 'Edit location' }} />

      <Stack.Screen name="products/index" options={{ title: 'Products' }} />
      <Stack.Screen name="products/new"   options={{ title: 'New product', presentation: 'modal' }} />
      <Stack.Screen name="products/[id]"  options={{ title: 'Edit product' }} />

      <Stack.Screen name="rates/index"        options={{ title: 'Rate card' }} />
      <Stack.Screen name="rates/[locationId]" options={{ title: 'Rate' }} />

      <Stack.Screen name="users/index" options={{ title: 'Users' }} />
      <Stack.Screen name="users/new"   options={{ title: 'New user', presentation: 'modal' }} />
      <Stack.Screen name="users/[id]"  options={{ title: 'Edit user' }} />
    </Stack>
  );
}
