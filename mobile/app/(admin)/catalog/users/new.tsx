import { useState } from 'react';
import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/Screen';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { createAppUser, listUsers, isWarehousePlace } from '@/services/users';
import type { Role } from '@/lib/permissions';
import { errorMessage } from '@/lib/errors';

const ROLE_OPTIONS: { value: Role; label: string; sub: string }[] = [
  { value: 'admin', label: 'Admin', sub: 'Full access. Sees margin. Manages everything.' },
  {
    value: 'dispatcher',
    label: 'Dispatcher',
    sub: 'Operational coordinator. No catalog or margin.',
  },
  { value: 'rep', label: 'Rep', sub: 'Same as dispatcher, with no stock access at all.' },
  { value: 'agent', label: 'Agent', sub: 'Rider. Own deliveries only.' },
  {
    value: 'warehouse',
    label: 'Warehouse',
    sub: 'A warehouse (stock holder), or staff who manage one.',
  },
];

export default function NewUser() {
  const placesQ = useAsync(() => listUsers(), []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const placeOptions = (placesQ.data ?? [])
    .filter(isWarehousePlace)
    .map((p) => ({ value: p.id, label: p.display_name }));

  async function handleSubmit() {
    setError(null);
    if (!email.trim()) {
      setError('Email is required');
      return;
    }
    if (!password) {
      setError('Password is required');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (!role) {
      setError('Role is required');
      return;
    }
    if (!displayName.trim()) {
      setError('Display name is required');
      return;
    }

    setSubmitting(true);
    try {
      await createAppUser({
        email: email.trim().toLowerCase(),
        password,
        role,
        displayName: displayName.trim(),
        phone: phone.trim() || null,
        warehouseId: role === 'warehouse' ? warehouseId : null,
      });
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <Screen>
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        required
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <Field
        label="Initial password"
        value={password}
        onChangeText={setPassword}
        required
        autoCapitalize="none"
        placeholder="8+ characters. Share securely; user can change later."
      />
      <Select
        label="Role"
        value={role}
        options={ROLE_OPTIONS.map((r) => ({ value: r.value, label: r.label, sub: r.sub }))}
        onChange={(v) => {
          setRole(v as Role | null);
          if (v !== 'warehouse') setWarehouseId(null);
        }}
        required
      />
      {role === 'warehouse' ? (
        <Select
          label="Belongs to warehouse"
          value={warehouseId}
          options={placeOptions}
          onChange={setWarehouseId}
          placeholder="Leave empty — this user IS a warehouse (a stock holder)"
        />
      ) : null}
      <Field
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        required
        autoCapitalize="words"
      />
      <Field
        label="Phone"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoCapitalize="none"
        placeholder="Optional"
      />

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button title="Create user" onPress={handleSubmit} loading={submitting} />
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
