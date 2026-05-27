import { useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { createLocation } from '@/services/locations';
import { parseAliases, parseCoord } from '@/lib/parse';
import { errorMessage } from '@/lib/errors';

export default function NewLocation() {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const lat = parseCoord(latitude, -90, 90, 'Latitude');
      const lon = parseCoord(longitude, -180, 180, 'Longitude');
      await createLocation({
        name: name.trim(),
        aliases: parseAliases(aliases),
        latitude: lat,
        longitude: lon,
      });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      <Field label="Name" value={name} onChangeText={setName} required autoCapitalize="words" />
      <Field
        label="Aliases (comma-separated)"
        value={aliases}
        onChangeText={setAliases}
        placeholder="e.g. Iganmu, Costain"
        autoCapitalize="none"
      />
      <Field
        label="Latitude"
        value={latitude}
        onChangeText={setLatitude}
        keyboardType="numeric"
        autoCapitalize="none"
        placeholder="Optional"
      />
      <Field
        label="Longitude"
        value={longitude}
        onChangeText={setLongitude}
        keyboardType="numeric"
        autoCapitalize="none"
        placeholder="Optional"
      />

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button title="Create location" onPress={handleSubmit} loading={submitting} />
      <Button
        title="Cancel"
        onPress={() => router.back()}
        variant="secondary"
        style={styles.cancel}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14 },
  cancel: { marginTop: 12 },
});
