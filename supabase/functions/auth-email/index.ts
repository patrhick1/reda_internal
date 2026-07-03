// Edge Function: auth-email
// ---------------------------------------------------------------------------
// GoTrue "Send Email" hook. When GOTRUE_HOOK_SEND_EMAIL is enabled, GoTrue POSTs
// every outbound auth email (password recovery, magic link, signup/confirm,
// email change) here INSTEAD of using its built-in SMTP — so we own delivery.
//
// Why a hook instead of plain SMTP: GoTrue's SMTP would mail WHOEVER requests a
// reset, but ~37 of our 38 accounts use placeholder logins (@reda.dev /
// @reda.local) with no real inbox. Mailing those just bounces and burns the
// Resend sending-domain reputation. This hook enforces two rules SMTP can't:
//   1. HARD-BLOCK placeholder/internal recipient domains (silently succeed, no send).
//   2. Send genuine recipients via Resend, always FROM noreply@redalogisticss.com.
//
// GoTrue config (supabase-auth env):
//   GOTRUE_HOOK_SEND_EMAIL_ENABLED=true
//   GOTRUE_HOOK_SEND_EMAIL_URI=http://kong:8000/functions/v1/auth-email
//   GOTRUE_HOOK_SEND_EMAIL_SECRETS=v1,whsec_<base64>      (shared with this fn)
// Function env:
//   RESEND_API_KEY               — Resend API key (Bearer)
//   SEND_EMAIL_HOOK_SECRET       — the base64 part after `whsec_` (sig verify)
//   AUTH_EMAIL_FROM (optional)   — defaults to "Reda <noreply@redalogisticss.com>"
//
// NOTE: reachable only INTERNALLY (GoTrue → kong over the docker network). It is
// NOT in the public Caddy allow-list, and authenticates via the GoTrue
// Standard-Webhooks signature — not the x-internal-secret gate.
// ---------------------------------------------------------------------------

const FROM = Deno.env.get('AUTH_EMAIL_FROM') ?? 'Reda <noreply@redalogisticss.com>';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
// GOTRUE_HOOK_SEND_EMAIL_SECRETS is "v1,whsec_<base64>"; we store just the
// <base64> here (the HMAC signing key). Empty disables verification (dev only).
const HOOK_SECRET_B64 = (Deno.env.get('SEND_EMAIL_HOOK_SECRET') ?? '')
  .replace(/^v1,/, '')
  .replace(/^whsec_/, '');

// Placeholder logins, NOT real inboxes — never email these (Uzo, 2026-06-28).
const BLOCKED_DOMAINS = new Set(['reda.dev', 'reda.local']);

function recipientBlocked(email: string): boolean {
  const domain = email.split('@')[1]?.trim().toLowerCase() ?? '';
  return domain === '' || BLOCKED_DOMAINS.has(domain);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8(s: string): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(enc.byteLength));
  out.set(enc);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Standard Webhooks verification (the scheme GoTrue uses). Signed content is
// `${id}.${timestamp}.${body}`; the signature header is a space-separated list
// of `v1,<base64sig>` — accept if any entry matches our HMAC-SHA256.
async function verifyGoTrueSignature(
  id: string,
  timestamp: string,
  body: string,
  sigHeader: string,
): Promise<boolean> {
  if (!HOOK_SECRET_B64) return true; // verification disabled (no secret configured)
  if (!id || !timestamp || !sigHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    b64ToBytes(HOOK_SECRET_B64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, utf8(`${id}.${timestamp}.${body}`));
  const expected = bytesToB64(new Uint8Array(mac));
  return sigHeader.split(' ').some((part) => {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    return sig === expected;
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function emailFor(actionType: string, link: string): { subject: string; html: string } {
  const button = (label: string) =>
    `<p style="margin:24px 0"><a href="${esc(link)}" style="background:#E63027;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-family:Arial,sans-serif;font-size:15px;display:inline-block">${label}</a></p>` +
    `<p style="font-family:Arial,sans-serif;font-size:12px;color:#777">If the button doesn't work, paste this link into your browser:<br>${esc(link)}</p>`;
  switch (actionType) {
    case 'recovery':
      return {
        subject: 'Reset your Reda password',
        html: `<div><p style="font-family:Arial,sans-serif;font-size:15px;color:#0A0A0A">We received a request to reset your Reda password. Click below to set a new one. If you didn't ask for this, you can ignore this email.</p>${button('Reset password')}</div>`,
      };
    case 'magiclink':
      return { subject: 'Your Reda sign-in link', html: `<div><p style="font-family:Arial,sans-serif;font-size:15px">Sign in to Reda:</p>${button('Sign in')}</div>` };
    case 'signup':
    case 'confirmation':
      return { subject: 'Confirm your Reda email', html: `<div><p style="font-family:Arial,sans-serif;font-size:15px">Confirm your email to finish setting up your Reda account:</p>${button('Confirm email')}</div>` };
    case 'email_change':
      return { subject: 'Confirm your new Reda email', html: `<div><p style="font-family:Arial,sans-serif;font-size:15px">Confirm your new email address for Reda:</p>${button('Confirm new email')}</div>` };
    default:
      return { subject: 'Reda account notification', html: `<div><p style="font-family:Arial,sans-serif;font-size:15px">Continue your Reda request:</p>${button('Continue')}</div>` };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  const ok = await verifyGoTrueSignature(
    req.headers.get('webhook-id') ?? '',
    req.headers.get('webhook-timestamp') ?? '',
    raw,
    req.headers.get('webhook-signature') ?? '',
  );
  if (!ok) {
    console.error('auth-email: invalid webhook signature');
    return new Response(JSON.stringify({ error: { http_code: 401, message: 'invalid signature' } }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  const email: string = payload?.user?.email ?? '';
  const ed = payload?.email_data ?? {};
  const actionType: string = ed.email_action_type ?? '';

  // GUARD: never send to placeholder/internal domains — succeed silently so the
  // auth flow isn't broken for those accounts, but no mail leaves the building.
  if (recipientBlocked(email)) {
    console.log('auth-email: skipped placeholder/internal recipient', { type: actionType });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }

  if (!RESEND_API_KEY) {
    console.error('auth-email: RESEND_API_KEY not configured');
    return new Response(JSON.stringify({ error: { http_code: 500, message: 'mailer not configured' } }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }

  // Mirror GoTrue's default ConfirmationURL template.
  const site = ed.site_url ?? '';
  const link = `${site}/auth/v1/verify?token=${encodeURIComponent(ed.token_hash ?? '')}` +
    `&type=${encodeURIComponent(actionType)}&redirect_to=${encodeURIComponent(ed.redirect_to ?? '')}`;
  const { subject, html } = emailFor(actionType, link);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [email], subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error('auth-email: resend send failed', res.status, body);
    return new Response(JSON.stringify({ error: { http_code: 500, message: 'send failed' } }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  }
  const sent = await res.json().catch(() => ({} as any));
  console.log('auth-email: sent via resend', { type: actionType, resend_id: sent?.id ?? null });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
});
