import { useEffect, useRef, useState } from 'react';
import { Share, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Banner, Button, Sheet } from '@/components/ui';
import { splitShareReport, type SharePart, type ShareReport } from '@/lib/share-report';
import { errorMessage } from '@/lib/errors';
import { colors, fonts } from '@/lib/theme';

/** Mount with a key identifying client/date range. Parts are a frozen snapshot,
 * retained on Close/Android Back, and discarded on Done or leaving this report. */
export function ClientReportShare({
  buildReport,
  disabled,
  loadError,
  onRetry,
}: {
  buildReport: () => ShareReport;
  disabled?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
}) {
  const [parts, setParts] = useState<SharePart[] | null>(null);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  async function share(text: string, single = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const ticket = generation.current;
    try {
      await Share.share({ message: text });
      if (ticket !== generation.current) return;
      // Android only confirms opening the share menu, not sending a message.
      // Never advance the part or mark the client notified here.
      if (single) setParts(null);
    } catch (e) {
      if (ticket !== generation.current) return;
      if (e && typeof e === 'object' && 'name' in e && e.name === 'AbortError') {
        if (single) setParts(null);
      } else {
        setError('Could not open sharing. Try again, or copy the message below.');
        setOpen(true);
      }
    } finally {
      if (ticket === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  function start() {
    if (pending.current) return;
    if (parts) {
      setOpen(true);
      return;
    }
    setError(null);
    setNotice(null);
    try {
      const next = splitShareReport(buildReport());
      setParts(next);
      setIndex(0);
      if (next.length > 1) setOpen(true);
      else void share(next[0]!.text, true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function copy() {
    if (!parts || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const ticket = generation.current;
    try {
      const copied = await Clipboard.setStringAsync(parts[index]!.text);
      if (!copied) throw new Error('Copy failed');
      if (ticket === generation.current) setNotice('Copied. Paste it into the same WhatsApp chat.');
    } catch {
      if (ticket === generation.current) setError('Could not copy. Try again or use Share.');
    } finally {
      if (ticket === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  function move(next: number) {
    setIndex(next);
    setError(null);
    setNotice(null);
  }
  function done() {
    generation.current++;
    setOpen(false);
    setParts(null);
    setIndex(0);
    setError(null);
    setNotice(null);
  }
  const multiple = !!parts && parts.length > 1;
  return (
    <>
      {loadError && !parts ? (
        <View style={{ gap: 8, marginBottom: 8 }}>
          <Banner tone="error">Could not load the complete update. Retry before sharing.</Banner>
          <Button variant="secondary" onPress={onRetry}>
            Retry
          </Button>
        </View>
      ) : null}
      {error && !parts ? <Banner tone="error">{error}</Banner> : null}
      <Button
        variant="emphasis"
        full
        icon="share"
        onPress={start}
        disabled={busy || (!parts && disabled)}
      >
        {parts
          ? multiple
            ? 'Continue sharing (' + (index + 1) + ' of ' + parts.length + ')'
            : 'Continue sharing'
          : 'Share with client'}
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Share delivery update"
        headerAction={
          <Button variant="ghost" size="sm" onPress={() => setOpen(false)}>
            Close
          </Button>
        }
        subtitle={
          multiple
            ? 'This update needs ' + parts.length + ' messages. Send each to the same chat.'
            : 'Share or copy this update.'
        }
        contentKey={index}
        maxWidth={640}
        footer={
          parts ? (
            <View style={{ gap: 8 }}>
              <Text
                accessibilityLiveRegion="polite"
                style={{ fontFamily: fonts.semibold, color: colors.textPrimary }}
              >
                {multiple ? 'Part ' + (index + 1) + ' of ' + parts.length : 'Delivery update'}
              </Text>
              <Text
                style={{ fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary }}
              >
                {multiple
                  ? 'Send in WhatsApp, then return here for the next part.'
                  : 'Choose WhatsApp from the share menu.'}
              </Text>
              {error ? (
                <View accessibilityRole="alert">
                  <Banner tone="error">{error}</Banner>
                </View>
              ) : null}
              {notice ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={{ fontFamily: fonts.medium, color: colors.textPrimary }}
                >
                  {notice}
                </Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 2 }}>
                  <Button
                    full
                    icon="share"
                    disabled={busy}
                    onPress={() => void share(parts[index]!.text)}
                  >
                    {multiple ? 'Share part ' + (index + 1) : 'Share update'}
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button full variant="secondary" disabled={busy} onPress={() => void copy()}>
                    Copy
                  </Button>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button
                    full
                    variant="ghost"
                    disabled={busy || index === 0}
                    onPress={() => move(index - 1)}
                  >
                    Previous
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    full
                    variant="secondary"
                    disabled={busy}
                    onPress={index + 1 === parts.length ? done : () => move(index + 1)}
                  >
                    {index + 1 === parts.length ? 'Done' : 'Next part'}
                  </Button>
                </View>
              </View>
            </View>
          ) : null
        }
      >
        <View style={{ padding: 20 }}>
          <Text
            selectable
            style={{
              fontFamily: fonts.regular,
              fontSize: 13,
              lineHeight: 21,
              color: colors.textPrimary,
            }}
          >
            {parts?.[index]?.text}
          </Text>
        </View>
      </Sheet>
    </>
  );
}
