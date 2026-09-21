type PushMessage = { to: string; [key: string]: unknown };

/** Provider acceptance only; receipt on a physical device is not guaranteed. */
export async function submitPushBatch(messages: PushMessage[], fetcher: typeof fetch = fetch) {
  const result = { accepted: 0, failed: 0, stale: [] as string[] };
  try {
    const response = await fetcher('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { ...result, failed: messages.length };
    const body = await response.json() as { data?: { status?: string; details?: { error?: string } }[] };
    for (let i = 0; i < messages.length; i++) {
      const ticket = body.data?.[i];
      if (ticket?.status === 'ok') result.accepted++;
      else if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') result.stale.push(messages[i].to);
      else result.failed++;
    }
    return result;
  } catch {
    return { ...result, failed: messages.length };
  }
}
