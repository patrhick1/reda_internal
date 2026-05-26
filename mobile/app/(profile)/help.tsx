import { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCurrentUser } from '@/hooks/useAuth';
import { AppBar, Card, Collapsible, Empty } from '@/components/ui';
import { HELP_BY_ROLE, type HelpSection, type HelpTopic } from '@/help/content';
import { HelpMarkdown } from '@/help/HelpMarkdown';
import { colors, fonts } from '@/lib/theme';

export default function HelpScreen() {
  const router = useRouter();
  const user = useCurrentUser();
  const params = useLocalSearchParams<{ topic?: string }>();
  const topic = (params.topic as HelpTopic | undefined) ?? null;

  // Widen to readonly HelpSection[] so length comparisons type-check (each
  // role's array has a literal `length`, which makes `=== 0` etc. dead-code).
  const sections: readonly HelpSection[] = HELP_BY_ROLE[user.role];

  // Track which sections are expanded. Deep-link `topic` auto-expands the
  // matching section once on mount; further taps are user-driven.
  const initial = useMemo(() => {
    const map: Record<string, boolean> = {};
    if (topic && sections.some((s) => s.id === topic)) {
      map[topic] = true;
    }
    return map;
  }, [topic, sections]);
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(initial);

  const setOpen = useCallback((id: string, next: boolean) => {
    setOpenMap((m) => ({ ...m, [id]: next }));
  }, []);

  // Scroll the deep-linked section into view after mount.
  const scrollRef = useRef<ScrollView>(null);
  const sectionYs = useRef<Record<string, number>>({});
  const scrolledRef = useRef(false);
  const handleSectionLayout = useCallback((id: string, y: number) => {
    sectionYs.current[id] = y;
    if (!scrolledRef.current && topic && id === topic) {
      scrolledRef.current = true;
      // Defer one frame so the expanded body has been laid out.
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
      });
    }
  }, [topic]);

  if (sections.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface }}>
        <AppBar title="Help" onBack={() => router.back()} />
        <Empty
          icon="alert"
          title="No help yet"
          sub="No help articles for your role yet — message Paschal."
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <AppBar
        title="Help"
        subtitle={`${sections.length} ${sections.length === 1 ? 'topic' : 'topics'}`}
        onBack={() => router.back()}
      />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}
      >
        <Card>
          <Text style={{ fontFamily: fonts.semibold, fontSize: 13, color: colors.textPrimary }}>
            Tap any topic to expand it. The <Text style={{ fontFamily: fonts.bold }}>?</Text> button in the top bar of any screen jumps straight to that screen&apos;s topic.
          </Text>
        </Card>

        {sections.map((s) => (
          <View
            key={s.id}
            onLayout={(e) => handleSectionLayout(s.id, e.nativeEvent.layout.y)}
          >
            <Collapsible
              title={s.title}
              icon={s.icon}
              expanded={!!openMap[s.id]}
              onChange={(next) => setOpen(s.id, next)}
            >
              <HelpMarkdown>{s.body}</HelpMarkdown>
            </Collapsible>
          </View>
        ))}

        <Text style={{
          fontFamily: fonts.medium,
          fontSize: 11,
          color: colors.textTertiary,
          textAlign: 'center',
          marginTop: 8,
        }}>
          Something missing or wrong? Message Paschal — he&apos;ll fix it the same day.
        </Text>
      </ScrollView>
    </View>
  );
}
