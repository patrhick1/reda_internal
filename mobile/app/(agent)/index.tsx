import { Redirect } from 'expo-router';

// The agent's home is the Today tab. AuthGate redirects active agents to
// `/(agent)` after sign-in; without this index, Expo Router renders the
// "Unmatched Route" screen because there's no plain (agent)/index page —
// only the `today/` subtree, `stock`, and `earnings`.
export default function AgentIndex() {
  return <Redirect href="/(agent)/today" />;
}
