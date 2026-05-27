import { useState } from 'react';
import { router } from 'expo-router';
import { Text, View, StyleSheet } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { createClient } from '@/services/clients';
import { errorMessage } from '@/lib/errors';

export default function NewClient() {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
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
      await createClient({
        name: name.trim(),
        contactPhone: phone.trim() || null,
        contactEmail: email.trim() || null,
        notes: notes.trim() || null,
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
        label="Contact phone"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoCapitalize="none"
      />
      <Field
        label="Contact email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <Field
        label="Notes"
        value={notes}
        onChangeText={setNotes}
        placeholder="Client rules visible to agents (e.g. 'No partial deliveries')"
        multiline
      />

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button title="Create client" onPress={handleSubmit} loading={submitting} />
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
