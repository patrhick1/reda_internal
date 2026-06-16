import { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Field } from '@/components/Field';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { useAsync } from '@/hooks/useAsync';
import { useAuth } from '@/hooks/useAuth';
import {
  deactivateUser,
  getAgentStock,
  getUser,
  isWarehousePlace,
  listAgentLocations,
  listUsers,
  reactivateUser,
  setAgentLocations,
  setUserCredentials,
  updateUser,
  type AgentStockRow,
  type AppUser,
} from '@/services/users';
import { listLocations, type Location } from '@/services/locations';
import type { Role } from '@/lib/permissions';
import { errorMessage } from '@/lib/errors';

type Disposition =
  | { kind: 'transfer'; targetAgentId: string }
  | { kind: 'warehouse' }
  | { kind: 'loss' };

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'dispatcher', label: 'Dispatcher' },
  { value: 'rep', label: 'Rep' },
  { value: 'agent', label: 'Agent' },
  { value: 'warehouse', label: 'Warehouse' },
];

export default function EditUser() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { account } = useAuth();
  const userQ = useAsync(() => getUser(id), [id]);
  const placesQ = useAsync(() => listUsers(), []);

  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [editingCreds, setEditingCreds] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (userQ.data) {
      setDisplayName(userQ.data.display_name);
      setRole(userQ.data.role);
      setPhone(userQ.data.phone ?? '');
      setWarehouseId(userQ.data.warehouse_id ?? null);
    }
  }, [userQ.data]);

  // Warehouse PLACES this user could belong to (excluding itself).
  const placeOptions = (placesQ.data ?? [])
    .filter((p) => isWarehousePlace(p) && p.id !== id)
    .map((p) => ({ value: p.id, label: p.display_name }));

  if (userQ.loading)
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  if (userQ.error || !userQ.data) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{userQ.error ?? 'User not found'}</Text>
        <Button title="Retry" onPress={userQ.reload} variant="secondary" />
      </View>
    );
  }

  const user = userQ.data;
  const isSelf = account.kind === 'active' && account.userId === user.id;
  const dirty =
    displayName !== user.display_name ||
    role !== user.role ||
    (phone || null) !== user.phone ||
    (warehouseId ?? null) !== (user.warehouse_id ?? null);

  async function handleSave() {
    if (!displayName.trim()) {
      setError('Display name is required');
      return;
    }
    if (!role) {
      setError('Role is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updateUser(
        user.id,
        {
          displayName: displayName.trim(),
          role,
          phone: phone.trim() || null,
          warehouseId: role === 'warehouse' ? warehouseId : null,
        },
        reason.trim() || null,
      );
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  async function handleReactivate() {
    setSubmitting(true);
    setError(null);
    try {
      await reactivateUser(user.id);
      router.back();
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {!user.is_active ? (
        <View style={styles.inactiveBanner}>
          <Text style={styles.inactiveText}>This user is inactive.</Text>
        </View>
      ) : null}

      <View style={styles.emailRow}>
        <Text style={styles.emailLabel}>Email</Text>
        <Text style={styles.emailValue}>{user.email}</Text>
      </View>

      {notice ? (
        <View style={styles.noticeBox}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}

      {!editingCreds ? (
        <Button
          title="Change email / password"
          variant="secondary"
          onPress={() => {
            setNotice(null);
            setError(null);
            setEditingCreds(true);
          }}
          style={styles.credToggle}
          disabled={submitting}
        />
      ) : (
        <CredentialsPanel
          user={user}
          onCancel={() => setEditingCreds(false)}
          onError={setError}
          onDone={() => {
            setEditingCreds(false);
            setNotice('Sign-in details updated. The user must log in with the new details.');
            userQ.reload();
          }}
        />
      )}

      <Field
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        required
        autoCapitalize="words"
      />
      <Select
        label="Role"
        value={role}
        options={ROLE_OPTIONS}
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
        label="Phone"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
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

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button title="Save changes" onPress={handleSave} loading={submitting} disabled={!dirty} />

      {user.role === 'agent' && user.is_active ? (
        <PreferredZones
          agentId={user.id}
          agentName={user.display_name.split(' ')[0] ?? user.display_name}
        />
      ) : null}

      {user.is_active ? (
        isSelf ? (
          <Text style={styles.helper}>
            You can’t deactivate your own account. Ask another admin to do it.
          </Text>
        ) : !deactivating ? (
          <Button
            title="Deactivate user"
            variant="danger"
            onPress={() => setDeactivating(true)}
            style={styles.bottom}
            disabled={submitting}
          />
        ) : (
          <DeactivatePanel user={user} onCancel={() => setDeactivating(false)} onError={setError} />
        )
      ) : (
        <Button
          title="Reactivate"
          onPress={handleReactivate}
          variant="secondary"
          style={styles.bottom}
          disabled={submitting}
        />
      )}
    </ScrollView>
  );
}

function CredentialsPanel({
  user,
  onCancel,
  onDone,
  onError,
}: {
  user: AppUser;
  onCancel: () => void;
  onDone: () => void;
  onError: (msg: string | null) => void;
}) {
  const [email, setEmail] = useState(user.email ?? '');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const emailChanged = email.trim().toLowerCase() !== (user.email ?? '').toLowerCase();
  const wantsPassword = password.length > 0;

  async function submit() {
    onError(null);
    const newEmail = email.trim().toLowerCase();
    if (!emailChanged && !wantsPassword) {
      onError('Change the email or enter a new password.');
      return;
    }
    if (emailChanged && !/^[^@]+@[^@]+\.[^@]+$/.test(newEmail)) {
      onError('Enter a valid email address.');
      return;
    }
    if (wantsPassword && password.length < 8) {
      onError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      await setUserCredentials(
        user.id,
        { email: emailChanged ? newEmail : null, password: wantsPassword ? password : null },
        reason.trim() || null,
      );
      onDone();
    } catch (e) {
      onError(errorMessage(e));
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.credPanel}>
      <Text style={styles.credTitle}>Change email / password</Text>
      <Text style={styles.panelHelper}>
        Sets new sign-in details for {user.display_name}. They’ll be signed out and must log in with
        the new details. Leave the password blank to change only the email.
      </Text>
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <Field
        label="New password"
        value={password}
        onChangeText={setPassword}
        autoCapitalize="none"
        placeholder="Leave blank to keep current. 8+ characters; share securely."
      />
      <Field
        label="Reason"
        value={reason}
        onChangeText={setReason}
        placeholder="Optional, for audit log"
      />
      <Button title="Update credentials" onPress={submit} loading={submitting} />
      <Button
        title="Cancel"
        variant="secondary"
        onPress={onCancel}
        style={styles.bottom}
        disabled={submitting}
      />
    </View>
  );
}

type ZoneKind = 'preferred' | 'avoid';

function PreferredZones({ agentId, agentName }: { agentId: string; agentName: string }) {
  const locsQ = useAsync<Location[]>(() => listLocations(), []);
  const currentQ = useAsync(() => listAgentLocations(agentId), [agentId]);

  const [picks, setPicks] = useState<Map<string, ZoneKind>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentQ.data) return;
    const next = new Map<string, ZoneKind>();
    for (const id of currentQ.data.preferred) next.set(id, 'preferred');
    for (const id of currentQ.data.avoided) next.set(id, 'avoid');
    setPicks(next);
  }, [currentQ.data]);

  const initial = useMemo(() => {
    const m = new Map<string, ZoneKind>();
    if (currentQ.data) {
      for (const id of currentQ.data.preferred) m.set(id, 'preferred');
      for (const id of currentQ.data.avoided) m.set(id, 'avoid');
    }
    return m;
  }, [currentQ.data]);

  const dirty = useMemo(() => {
    if (picks.size !== initial.size) return true;
    for (const [id, k] of picks) if (initial.get(id) !== k) return true;
    return false;
  }, [picks, initial]);

  const counts = useMemo(() => {
    let p = 0,
      a = 0;
    for (const k of picks.values()) {
      if (k === 'preferred') p++;
      else a++;
    }
    return { preferred: p, avoid: a };
  }, [picks]);

  function cycle(id: string) {
    setPicks((m) => {
      const next = new Map(m);
      const cur = next.get(id);
      if (cur === undefined) next.set(id, 'preferred');
      else if (cur === 'preferred') next.set(id, 'avoid');
      else next.delete(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const preferredIds: string[] = [];
      const avoidedIds: string[] = [];
      for (const [id, k] of picks) {
        if (k === 'preferred') preferredIds.push(id);
        else avoidedIds.push(id);
      }
      await setAgentLocations(agentId, preferredIds, avoidedIds);
      currentQ.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (locsQ.loading || currentQ.loading) {
    return (
      <View style={zoneStyles.section}>
        <Text style={zoneStyles.heading}>Zone preferences</Text>
        <ActivityIndicator />
      </View>
    );
  }

  const locs = locsQ.data ?? [];

  let summary: string;
  if (counts.preferred === 0 && counts.avoid === 0) {
    summary = `No preferences set. ${agentName} is flexible across all zones.`;
  } else if (counts.avoid === 0) {
    summary = `${counts.preferred} preferred ${counts.preferred === 1 ? 'zone' : 'zones'}. Auto-assign favours ${agentName} there.`;
  } else if (counts.preferred === 0) {
    summary = `${counts.avoid} avoided ${counts.avoid === 1 ? 'zone' : 'zones'}. Auto-assign skips ${agentName} there unless no one else is eligible.`;
  } else {
    summary = `${counts.preferred} preferred · ${counts.avoid} avoided.`;
  }

  return (
    <View style={zoneStyles.section}>
      <Text style={zoneStyles.heading}>Zone preferences</Text>
      <Text style={zoneStyles.helper}>
        Tap a zone to mark <Text style={zoneStyles.helperPref}>preferred</Text> (priority). Tap
        again for <Text style={zoneStyles.helperAvoid}>avoid</Text> (last-resort). Tap a third time
        to clear.
      </Text>
      <Text style={zoneStyles.summary}>{summary}</Text>

      <View style={zoneStyles.chipWrap}>
        {locs.map((loc) => {
          const kind = picks.get(loc.id);
          const chipStyle = [
            zoneStyles.chip,
            kind === 'preferred' && zoneStyles.chipPreferred,
            kind === 'avoid' && zoneStyles.chipAvoid,
          ];
          const labelStyle = [
            zoneStyles.chipLabel,
            kind === 'preferred' && zoneStyles.chipLabelPreferred,
            kind === 'avoid' && zoneStyles.chipLabelAvoid,
          ];
          const prefix = kind === 'preferred' ? '✓ ' : kind === 'avoid' ? '✕ ' : '';
          return (
            <Pressable
              key={loc.id}
              onPress={() => cycle(loc.id)}
              style={({ pressed }) => [chipStyle, pressed && { opacity: 0.85 }]}
            >
              <Text style={labelStyle}>
                {prefix}
                {loc.name}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <Button
        title={dirty ? 'Save zones' : 'Saved'}
        onPress={save}
        loading={saving}
        disabled={!dirty || saving}
        variant="secondary"
      />
    </View>
  );
}

const zoneStyles = StyleSheet.create({
  section: {
    marginTop: 24,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  heading: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 6 },
  helper: { fontSize: 12, color: '#666', lineHeight: 17, marginBottom: 4 },
  helperPref: { color: '#16704a', fontWeight: '600' },
  helperAvoid: { color: '#a02d1b', fontWeight: '600' },
  summary: { fontSize: 12, color: '#444', marginBottom: 12, fontStyle: 'italic' },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#fff',
  },
  chipPreferred: {
    borderColor: '#16704a',
    backgroundColor: '#e6f4ec',
  },
  chipAvoid: {
    borderColor: '#a02d1b',
    backgroundColor: '#fdecea',
  },
  chipLabel: { fontSize: 13, color: '#222' },
  chipLabelPreferred: { color: '#16704a', fontWeight: '600' },
  chipLabelAvoid: { color: '#a02d1b', fontWeight: '600' },
});

function DeactivatePanel({
  user,
  onCancel,
  onError,
}: {
  user: AppUser;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const stockQ = useAsync(
    () => (user.role === 'agent' ? getAgentStock(user.id) : Promise.resolve([])),
    [user.id, user.role],
  );
  const agentsQ = useAsync(
    () => listUsers().then((all) => all.filter((u) => u.role === 'agent' && u.id !== user.id)),
    [user.id],
  );

  const [disposition, setDisposition] = useState<Disposition | null>(null);
  const [transferAgentId, setTransferAgentId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const hasStock = (stockQ.data ?? []).length > 0;

  async function confirm() {
    onError(null);
    if (!reason.trim()) {
      onError('Reason is required');
      return;
    }
    let dispoString: string | null = null;
    if (user.role === 'agent' && hasStock) {
      if (!disposition) {
        onError('Pick a stock disposition');
        return;
      }
      if (disposition.kind === 'transfer') {
        if (!transferAgentId) {
          onError('Pick the agent to receive the stock');
          return;
        }
        dispoString = `transfer:${transferAgentId}`;
      } else {
        dispoString = disposition.kind;
      }
    }
    setSubmitting(true);
    try {
      await deactivateUser(user.id, reason.trim(), dispoString);
      router.back();
    } catch (e) {
      onError(errorMessage(e));
      setSubmitting(false);
    }
  }

  if (stockQ.loading) {
    return (
      <View style={styles.panelCenter}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.panelTitle}>Deactivate {user.display_name}?</Text>

      {user.role === 'agent' && hasStock ? (
        <>
          <Text style={styles.panelSub}>
            This agent is currently holding stock. Choose what happens to it.
          </Text>
          <View style={styles.stockBox}>
            {(stockQ.data ?? []).map((s) => (
              <StockLine key={s.product_catalog_id} item={s} />
            ))}
          </View>

          <DispositionRow
            label="Transfer to another agent"
            selected={disposition?.kind === 'transfer'}
            onPress={() =>
              setDisposition({ kind: 'transfer', targetAgentId: transferAgentId ?? '' })
            }
          />
          {disposition?.kind === 'transfer' ? (
            <View style={styles.indent}>
              <Select
                label="Recipient agent"
                value={transferAgentId}
                options={(agentsQ.data ?? [])
                  .filter((a) => a.is_active)
                  .map((a) => ({ value: a.id, label: a.display_name }))}
                onChange={setTransferAgentId}
              />
            </View>
          ) : null}

          <DispositionRow
            label="Return all to warehouse"
            selected={disposition?.kind === 'warehouse'}
            onPress={() => setDisposition({ kind: 'warehouse' })}
          />
          <DispositionRow
            label="Write off as loss"
            selected={disposition?.kind === 'loss'}
            onPress={() => setDisposition({ kind: 'loss' })}
          />

          <Text style={styles.panelHelper}>
            Stock movement is recorded now and the actual adjustments are applied in Phase 4
            (Stock).
          </Text>
        </>
      ) : user.role === 'agent' ? (
        <Text style={styles.panelSub}>Agent has no stock on hand — clean deactivation.</Text>
      ) : null}

      <Field
        label="Reason"
        value={reason}
        onChangeText={setReason}
        required
        placeholder="e.g. resigned, performance"
      />

      <Button
        title="Confirm deactivation"
        variant="danger"
        onPress={confirm}
        loading={submitting}
      />
      <Button
        title="Cancel"
        variant="secondary"
        onPress={onCancel}
        style={styles.bottom}
        disabled={submitting}
      />
    </View>
  );
}

function StockLine({ item }: { item: AgentStockRow }) {
  return (
    <View style={styles.stockLine}>
      <View style={{ flex: 1 }}>
        <Text style={styles.stockName}>{item.product_name}</Text>
        <Text style={styles.stockClient}>{item.client_name}</Text>
      </View>
      <Text style={styles.stockQty}>{item.quantity_on_hand}</Text>
    </View>
  );
}

function DispositionRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <View style={[styles.dispoRow, selected && styles.dispoRowActive]} onTouchEnd={onPress}>
      <View style={[styles.radio, selected && styles.radioActive]}>
        {selected ? <View style={styles.radioInner} /> : null}
      </View>
      <Text style={styles.dispoLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingBottom: 48 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  errorBox: { backgroundColor: '#fdecea', padding: 12, borderRadius: 8, marginBottom: 12 },
  errorText: { color: '#a02d1b', fontSize: 14, textAlign: 'center' },
  inactiveBanner: { backgroundColor: '#fff4e0', padding: 12, borderRadius: 8, marginBottom: 16 },
  inactiveText: { color: '#a04000', fontWeight: '600' },
  emailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    backgroundColor: '#f6f6f6',
    marginBottom: 16,
  },
  emailLabel: { fontSize: 13, color: '#666', fontWeight: '600' },
  emailValue: { fontSize: 14, color: '#111' },
  bottom: { marginTop: 12 },
  helper: { fontSize: 12, color: '#888', marginTop: 24, textAlign: 'center' },
  credToggle: { marginBottom: 16 },
  noticeBox: { backgroundColor: '#e6f4ec', padding: 12, borderRadius: 8, marginBottom: 16 },
  noticeText: { color: '#16704a', fontSize: 14, textAlign: 'center' },
  credPanel: {
    marginBottom: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e2e2',
    borderRadius: 8,
    backgroundColor: '#fafafa',
  },
  credTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 8 },

  panel: {
    marginTop: 24,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e9c8c2',
    borderRadius: 8,
    backgroundColor: '#fff8f6',
  },
  panelCenter: { padding: 16, alignItems: 'center' },
  panelTitle: { fontSize: 16, fontWeight: '700', color: '#a02d1b', marginBottom: 8 },
  panelSub: { fontSize: 13, color: '#444', marginBottom: 12, lineHeight: 18 },
  panelHelper: { fontSize: 11, color: '#888', marginBottom: 12, fontStyle: 'italic' },

  stockBox: {
    backgroundColor: '#fff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#eee',
    padding: 10,
    marginBottom: 14,
  },
  stockLine: { flexDirection: 'row', paddingVertical: 6, alignItems: 'center' },
  stockName: { fontSize: 14, color: '#111', fontWeight: '500' },
  stockClient: { fontSize: 12, color: '#666' },
  stockQty: { fontSize: 16, color: '#111', fontWeight: '600' },

  dispoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 6,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#eee',
    backgroundColor: '#fff',
  },
  dispoRowActive: { borderColor: '#a02d1b', backgroundColor: '#fff' },
  dispoLabel: { fontSize: 14, color: '#222', flex: 1 },
  indent: { paddingLeft: 28, marginBottom: 6 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: '#bbb',
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioActive: { borderColor: '#a02d1b' },
  radioInner: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#a02d1b' },
});
