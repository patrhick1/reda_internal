import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Empty } from './Empty';
import { colors, fonts } from '@/lib/theme';
import { logError } from '@/lib/sentry';

// Class component because hooks can't catch render errors — getDerivedStateFromError
// + componentDidCatch are the only API for this. Wrapped around the app's <Slot/>
// so a render error anywhere below shows a recovery UI instead of a blank screen.

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    logError('error-boundary', error, { componentStack: info.componentStack ?? null });
  }

  reset = () => {
    this.setState({ error: null });
  };

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.surface,
          paddingHorizontal: 24,
          justifyContent: 'center',
        }}
      >
        <Empty
          icon="alert"
          title="Something went wrong"
          sub={
            this.state.error.message ||
            'The screen hit an unexpected error. Tap Try again to retry — your saved changes are safe in the sync queue.'
          }
        />
        <Pressable
          onPress={this.reset}
          style={({ pressed }) => [
            {
              marginTop: 16,
              alignSelf: 'center',
              paddingVertical: 12,
              paddingHorizontal: 24,
              backgroundColor: colors.black,
              borderRadius: 999,
            },
            pressed && { opacity: 0.85 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Try again"
        >
          <Text style={{ fontFamily: fonts.bold, fontSize: 14, color: colors.white }}>
            Try again
          </Text>
        </Pressable>
      </View>
    );
  }
}
