// Edge Function: scheduled-eod-check
//
// Run by Supabase Scheduled Edge Functions cron at 20:00 UTC (= 21:00 Lagos,
// past the typical end-of-deliveries window). Configure schedule in the
// dashboard: Edge Functions → scheduled-eod-check → Schedule → 0 20 * * *
//
// What it does:
//   1. Signs in as the "Reda System" admin user (a real users row — see
//      scripts/system-user-setup.sql). This gives the cron a real auth.uid()
//      so every downstream RPC works through its normal admin role checks,
//      and audit rows are attributed to "Reda System".
//   2. Calls run_eod_rollover_all_stuck() which finds every stuck date and
//      rolls each one's non-terminal deliveries forward via the existing
//      run_eod_rollover RPC. Sunday-skip is baked into _ensure_workday
//      inside rollover_delivery.
//   3. Sends an admin push describing the outcome (success, no-op, or
//      failure). We deliberately don't name the target date in the body —
//      mixed stuck dates roll to different targets and a single sentence
//      can't describe that without lying. The EOD screen / deliveries list
//      is the source of truth.
//
// Deploy: supabase functions deploy scheduled-eod-check

// deno-lint-ignore-file no-explicit-any
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

Deno.serve(async (_req) => {
  const supabaseUrl  = Deno.env.get('SUPABASE_URL');
  const anonKey      = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const systemEmail  = Deno.env.get('SYSTEM_USER_EMAIL');
  const systemPass   = Deno.env.get('SYSTEM_USER_PASSWORD');
  if (!supabaseUrl || !anonKey || !serviceKey || !systemEmail || !systemPass) {
    console.error('missing env: need SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SYSTEM_USER_EMAIL, SYSTEM_USER_PASSWORD');
    return new Response('server misconfigured', { status: 500 });
  }

  // Sign in as the Reda System admin. The resulting client has a real JWT,
  // so auth.uid() is set inside RPCs and the existing is_admin_or_dispatcher()
  // checks pass naturally.
  const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { error: signinErr } = await supabase.auth.signInWithPassword({
    email:    systemEmail,
    password: systemPass,
  });
  if (signinErr) {
    console.error('system user signin failed', signinErr);
    await notify(supabaseUrl, serviceKey, {
      title: 'Auto end of day FAILED',
      body:  `Sign-in as Reda System failed: ${signinErr.message}. Run EOD manually.`,
    });
    return new Response('signin failed', { status: 500 });
  }

  // Run the rollover for every stuck date.
  const { data, error: rpcErr } = await supabase.rpc('run_eod_rollover_all_stuck', {
    p_reason: 'auto_eod_cron',
  });
  if (rpcErr) {
    console.error('rollover rpc failed', rpcErr);
    await notify(supabaseUrl, serviceKey, {
      title: 'Auto end of day FAILED',
      body:  `Open the EOD screen and run it manually. (${rpcErr.message})`,
    });
    return new Response(rpcErr.message, { status: 500 });
  }

  const rolled = typeof data === 'number' ? data : 0;
  await notify(supabaseUrl, serviceKey,
    rolled === 0
      ? { title: 'Auto end of day', body: 'All clear — nothing to roll.' }
      : { title: 'Auto end of day', body: `Rolled ${rolled} ${rolled === 1 ? 'delivery' : 'deliveries'} forward. Tap to review.` },
  );

  return new Response(JSON.stringify({ rolled }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

async function notify(
  supabaseUrl: string,
  serviceKey: string,
  msg: { title: string; body: string },
): Promise<void> {
  const res = await fetch(`${supabaseUrl}/functions/v1/send-notification`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      audience: 'admins',
      title:    msg.title,
      body:     msg.body,
      data:     { route: 'eod' },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('send-notification failed', res.status, errText);
  }
}
