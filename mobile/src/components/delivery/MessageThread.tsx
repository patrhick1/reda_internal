import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useAsync } from '@/hooks/useAsync';
import { Card, Input } from '@/components/ui';
import { colors, fonts, STATUS_META, TERMINAL_STATUSES } from '@/lib/theme';
import { formatDateTime } from '@/lib/format';
import {
  ISSUE_LABELS,
  listMessages,
  markRead,
  postReply,
  type AuthorRole,
  type DeliveryMessage,
} from '@/services/delivery-messages';
import { newClientUuid } from '@/lib/uuid';
import { errorMessage } from '@/lib/errors';

/** Per-delivery message thread. Stays hidden until the agent has flagged
 *  something — keeps the screen quiet during the common no-issue case. */
export function MessageThread({
  deliveryId,
  deliveryStatus,
  canReply,
}: {
  deliveryId: string;
  /** Parent passes this so we don't re-fetch the delivery just to know if
   *  the thread is open. Pass the optimistic value if the parent screen has
   *  one. */
  deliveryStatus: string | null | undefined;
  canReply: boolean;
}) {
  const messagesQ = useAsync(() => listMessages(deliveryId), [deliveryId]);

  useFocusEffect(
    useCallback(() => {
      messagesQ.reload();
      // Mark-read can fail silently — it's not user-visible.
      markRead(deliveryId).catch(() => undefined);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deliveryId]),
  );

  const isOpen = !TERMINAL_STATUSES.has(deliveryStatus ?? '');
  const messages = messagesQ.data ?? [];

  if (messagesQ.loading && messages.length === 0) {
    return (
      <Card>
        <Text style={kicker}>Messages</Text>
        <View style={{ paddingVertical: 16, alignItems: 'center' }}>
          <ActivityIndicator color={colors.black} />
        </View>
      </Card>
    );
  }

  // Stay quiet until an agent flag exists. Ops never seed; agents start a
  // thread via FlagDeliverySheet (not this composer).
  if (messages.length === 0) return null;

  return (
    <Card>
      <Text style={kicker}>Messages</Text>
      <View style={{ marginTop: 12, gap: 10 }}>
        {messages.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
      </View>
      {isOpen && canReply ? (
        <ReplyComposer deliveryId={deliveryId} onSent={() => messagesQ.reload()} />
      ) : !isOpen ? (
        <View
          style={{
            marginTop: 14,
            padding: 10,
            backgroundColor: colors.surface,
            borderRadius: 10,
          }}
        >
          <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary }}>
            Thread closed — delivery is {STATUS_META[deliveryStatus ?? '']?.label ?? deliveryStatus}
            .
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function Bubble({ message }: { message: DeliveryMessage }) {
  const align = message.fromOps ? 'flex-end' : 'flex-start';
  const bg = message.fromOps ? colors.black : colors.surface;
  const fg = message.fromOps ? colors.white : colors.black;
  const subFg = message.fromOps ? '#bbb' : colors.textSecondary;

  return (
    <View style={{ alignItems: align }}>
      <View
        style={{
          maxWidth: '85%',
          backgroundColor: bg,
          borderRadius: 12,
          paddingVertical: 10,
          paddingHorizontal: 12,
          gap: 4,
        }}
      >
        {message.issue_type ? (
          <View
            style={{
              alignSelf: 'flex-start',
              backgroundColor: message.fromOps ? '#333' : colors.white,
              borderWidth: message.fromOps ? 0 : 1,
              borderColor: colors.border,
              borderRadius: 999,
              paddingVertical: 2,
              paddingHorizontal: 8,
              marginBottom: 4,
            }}
          >
            <Text
              style={{
                fontFamily: fonts.bold,
                fontSize: 10,
                color: message.fromOps ? colors.white : colors.black,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              {ISSUE_LABELS[message.issue_type]}
            </Text>
          </View>
        ) : null}
        {message.note ? (
          <Text style={{ fontFamily: fonts.medium, fontSize: 14, color: fg, lineHeight: 19 }}>
            {message.note}
          </Text>
        ) : null}
        <Text style={{ fontFamily: fonts.regular, fontSize: 11, color: subFg, marginTop: 2 }}>
          {message.author_name ?? labelForRole(message.author_role)}
          {' · '}
          {formatDateTime(message.created_at)}
        </Text>
      </View>
    </View>
  );
}

function ReplyComposer({ deliveryId, onSent }: { deliveryId: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Fresh idempotency token per successful send. A retry of the same
  // submission reuses this value via the closure capture in `send`.
  const [clientUuid, setClientUuid] = useState<string>(() => newClientUuid());

  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await postReply({ deliveryId, text: trimmed, clientUuid });
      setText('');
      setClientUuid(newClientUuid());
      onSent();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={{ marginTop: 14, gap: 8 }}>
      <Input
        value={text}
        onChange={setText}
        placeholder="Reply…"
        autoCapitalize="sentences"
        multiline
      />
      {error ? (
        <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.red }}>{error}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Pressable
          onPress={send}
          disabled={!text.trim() || sending}
          style={({ pressed }) => [
            {
              paddingVertical: 10,
              paddingHorizontal: 18,
              borderRadius: 999,
              backgroundColor: colors.black,
              opacity: !text.trim() || sending ? 0.5 : 1,
            },
            pressed && text.trim() && !sending && { opacity: 0.9 },
          ]}
        >
          <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: colors.white }}>
            {sending ? 'Sending…' : 'Send'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function labelForRole(r: AuthorRole): string {
  return r === 'agent' ? 'Agent' : r === 'admin' ? 'Admin' : 'Dispatcher';
}

const kicker = {
  fontFamily: fonts.bold,
  fontSize: 11,
  color: colors.textSecondary,
  letterSpacing: 0.8,
  textTransform: 'uppercase' as const,
};
