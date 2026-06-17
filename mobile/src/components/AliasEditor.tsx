import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radii } from '@/lib/theme';
import { Icon, Input } from '@/components/ui';
import { parseAliases } from '@/lib/parse';

/** Edits a location's aliases as a searchable chip list instead of one long
 *  comma-separated text box. The single input doubles as search (filters the
 *  chips live) and add (type a new alias — or a comma-separated batch — and
 *  submit). Operating on the string[] directly means alias values that contain
 *  commas survive a round-trip, which the old join(', ')/split(',') field
 *  silently corrupted.
 *
 *  Controlled: holds no alias state of its own beyond the query box; every
 *  add/remove calls `onChange` with the next array. */
export function AliasEditor({
  aliases,
  onChange,
  label = 'Aliases',
}: {
  aliases: string[];
  onChange: (next: string[]) => void;
  label?: string;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const filtered = useMemo(
    () => (needle ? aliases.filter((a) => a.toLowerCase().includes(needle)) : aliases),
    [aliases, needle],
  );

  // What submitting the box would add: the typed text split + trimmed + deduped
  // (parseAliases) minus anything already present (case-insensitive). Drives the
  // Add button and the "already added" hint.
  const existingLower = useMemo(() => new Set(aliases.map((a) => a.toLowerCase())), [aliases]);
  const toAdd = useMemo(
    () => parseAliases(query).filter((p) => !existingLower.has(p.toLowerCase())),
    [query, existingLower],
  );
  const queryNonEmpty = query.trim().length > 0;

  function add() {
    if (toAdd.length > 0) onChange([...aliases, ...toAdd]);
    setQuery('');
  }

  function remove(alias: string) {
    onChange(aliases.filter((a) => a !== alias));
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.count}>
          {needle ? `${filtered.length} of ${aliases.length}` : `${aliases.length} total`}
        </Text>
      </View>

      <Input
        icon="search"
        value={query}
        onChange={setQuery}
        placeholder="Search or add alias"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        onSubmitEditing={add}
        rightAdornment={
          queryNonEmpty ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear">
              <Icon name="x" size={16} color={colors.textSecondary} />
            </Pressable>
          ) : null
        }
      />

      {queryNonEmpty ? (
        toAdd.length > 0 ? (
          <Pressable
            onPress={add}
            style={({ pressed }) => [styles.addRow, pressed && { opacity: 0.85 }]}
          >
            <Icon name="plus" size={16} color={colors.red} />
            <Text style={styles.addText} numberOfLines={1}>
              Add {toAdd.map((a) => `"${a}"`).join(', ')}
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.hint}>Already added.</Text>
        )
      ) : null}

      <View style={styles.chips}>
        {filtered.length === 0 ? (
          <Text style={styles.empty}>
            {aliases.length === 0
              ? 'No aliases yet. Type one above and tap Add.'
              : 'No aliases match your search.'}
          </Text>
        ) : (
          filtered.map((alias) => (
            <View key={alias} style={styles.chip}>
              <Text style={styles.chipText}>{alias}</Text>
              <Pressable
                onPress={() => remove(alias)}
                hitSlop={6}
                accessibilityLabel={`Remove ${alias}`}
              >
                <Icon name="x" size={14} color={colors.textSecondary} />
              </Pressable>
            </View>
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  label: { fontFamily: fonts.semibold, fontSize: 12, color: colors.textSecondary },
  count: { fontFamily: fonts.medium, fontSize: 12, color: colors.textTertiary },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  addText: { flex: 1, fontFamily: fonts.semibold, fontSize: 13, color: colors.red },
  hint: { marginTop: 10, fontFamily: fonts.medium, fontSize: 12, color: colors.textTertiary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  empty: { fontFamily: fonts.medium, fontSize: 13, color: colors.textTertiary, paddingVertical: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 12,
    paddingRight: 8,
    paddingVertical: 7,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { fontFamily: fonts.medium, fontSize: 13, color: colors.black },
});
