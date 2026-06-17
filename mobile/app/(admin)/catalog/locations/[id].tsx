import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { AliasEditor } from '@/components/AliasEditor';
import { Button } from '@/components/Button';
import { useAsync } from '@/hooks/useAsync';
import {
  deactivateLocation,
  getLocation,
  reactivateLocation,
  updateLocation,
} from '@/services/locations';
import { parseCoord } from '@/lib/parse';
import { errorMessage } from '@/lib/errors';

export default function EditLocation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: location, loading, error, reload } = useAsync(() => getLocation(id), [id]);

  const [name, setName] = useState('');
  const [aliases, setAliases] = useState<string[]>([]);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (location) {
      setName(location.name);
      setAliases(location.aliases ?? []);
      setLatitude(location.latitude !== null ? String(location.latitude) : '');
      setLongitude(location.longitude !== null ? String(location.longitude) : '');
    }
  }, [location]);

  if (loading)
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  if (error || !location) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error ?? 'Location not found'}</Text>
        <Button title="Retry" onPress={reload} variant="secondary" />
      </View>
    );
  }

  const origAliases = location.aliases ?? [];
  const aliasesDirty =
    aliases.length !== origAliases.length || aliases.some((a, i) => a !== origAliases[i]);
  const dirty =
    name !== location.name ||
    aliasesDirty ||
    latitude !== (location.latitude !== null ? String(location.latitude) : '') ||
    longitude !== (location.longitude !== null ? String(location.longitude) : '');

  async function handleSave() {
    if (!name.trim()) {
      setActionError('Name is required');
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      const lat = parseCoord(latitude, -90, 90, 'Latitude');
      const lon = parseCoord(longitude, -180, 180, 'Longitude');
      await updateLocation(
        location!.id,
        {
          name: name.trim(),
          aliases,
          latitude: lat,
          longitude: lon,
        },
        reason.trim() || null,
      );
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  async function performDeactivate(why: string) {
    setSubmitting(true);
    setActionError(null);
    try {
      await deactivateLocation(location!.id, why);
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  function handleDeactivate() {
    if (Platform.OS === 'web') {
      const why =
        (typeof window !== 'undefined' ? window.prompt('Reason for deactivation:') : null) ?? '';
      if (why.trim()) performDeactivate(why.trim());
      else setActionError('Reason required');
      return;
    }
    Alert.prompt(
      'Deactivate location',
      'Reason (required). Existing deliveries to this location still work; new ones are blocked.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: (why?: string) => {
            if (why && why.trim()) performDeactivate(why.trim());
            else setActionError('Reason required');
          },
        },
      ],
      'plain-text',
    );
  }

  async function handleReactivate() {
    setSubmitting(true);
    setActionError(null);
    try {
      await reactivateLocation(location!.id);
      router.back();
    } catch (e) {
      setActionError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      {!location.is_active ? (
        <View style={styles.inactiveBanner}>
          <Text style={styles.inactiveText}>This location is inactive.</Text>
        </View>
      ) : null}

      <Field label="Name" value={name} onChangeText={setName} required autoCapitalize="words" />
      <AliasEditor aliases={aliases} onChange={setAliases} />
      <Field
        label="Latitude"
        value={latitude}
        onChangeText={setLatitude}
        keyboardType="numeric"
        autoCapitalize="none"
      />
      <Field
        label="Longitude"
        value={longitude}
        onChangeText={setLongitude}
        keyboardType="numeric"
        autoCapitalize="none"
      />

      {dirty ? (
        <Field
          label="Reason for change"
          value={reason}
          onChangeText={setReason}
          placeholder="Optional but recommended for audit log"
        />
      ) : null}

      {actionError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{actionError}</Text>
        </View>
      ) : null}

      <Button title="Save changes" onPress={handleSave} loading={submitting} disabled={!dirty} />

      {location.is_active ? (
        <Button
          title="Deactivate"
          onPress={handleDeactivate}
          variant="danger"
          style={styles.bottom}
          disabled={submitting}
        />
      ) : (
        <Button
          title="Reactivate"
          onPress={handleReactivate}
          variant="secondary"
          style={styles.bottom}
          disabled={submitting}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  error: { color: '#c0392b', textAlign: 'center', marginBottom: 12 },
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  inactiveBanner: { backgroundColor: '#fff4e0', padding: 12, borderRadius: 8, marginBottom: 16 },
  inactiveText: { color: '#a04000', fontWeight: '600' },
  bottom: { marginTop: 24 },
});
