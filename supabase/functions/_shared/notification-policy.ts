/** Keep blacklist notices quiet while preserving urgent delivery/call behavior. */
export function notificationPresentation(data: Record<string, unknown> | undefined) {
  return data?.kind === 'blacklist_blocked'
    ? { sound: null, priority: 'normal', channelId: 'blocked-orders', tag: 'blocked-orders' }
    : { sound: 'default', priority: 'high', channelId: 'default' };
}
