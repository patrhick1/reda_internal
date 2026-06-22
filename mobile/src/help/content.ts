import type { Role } from '@/lib/permissions';
import type { IconName } from '@/components/ui';

export type HelpSection = {
  /** Slug used as the deep-link `topic` param. Becomes part of HelpTopic. */
  id: string;
  /** Card heading. Plain text. */
  title: string;
  /** Optional leading icon on the collapsed card. */
  icon?: IconName;
  /** Body in plain markdown. Rendered with HelpMarkdown. */
  body: string;
};

const ADMIN = [
  {
    id: 'sign-in',
    title: 'Sign in & manage your account',
    icon: 'user',
    body: `- App icon → enter your email and password. Tap the eye icon on the password field to peek at what you typed.
- If you forget the password, tap *Forgot password* on the login screen, type your own email, and a reset link is mailed to **you** (not the shared inbox). Click the link and set a new password.
- After signing in once, the app pre-fills your email on next launch.
- (Optional) Profile → *Unlock with Face ID / Fingerprint* — turn this on and the app asks for your face or finger every time you open it. You stay signed in either way; the face check is just an extra lock on the door.

### Manage your account

- Tap the gear icon in the top-right of *Home* → *Profile*.
- **Edit profile** — change your display name or phone. Email stays fixed; if it really needs to change, message Paschal.
- **Change password** — enter your current password, then the new one twice. We don't store the old password anywhere, so if you mistype the current one it just bounces you back.`,
  },
  {
    id: 'new-delivery',
    title: 'Add a delivery manually',
    icon: 'plus',
    body: `When an agent or customer messages you a delivery that the bot can't handle:

1. Tap **Home → New delivery** (the red square in Quick Actions), or **Deliveries → +** (the floating red button).
2. Fill in the customer name, phone, address.
3. Tap the client chip (e.g. *Aernings*) → tap the product.
4. Set quantity + customer price.
5. Leave **Location** empty if you're not sure — it'll show up in *Review* so you can sort it out later.
6. Leave **Agent** empty and the app picks the right one. Only pick a specific agent if you want to override that.
7. Tap **Create delivery**.

The agent gets a notification on their phone within seconds.

### Race-to-deliver — assigning the same order to multiple agents

If you create the same delivery for multiple agents (same customer phone, product, day, address, quantity) so whoever arrives first delivers it, the app handles the coordination automatically:

- When one agent taps **I'm en route**, the other agents get a **Stand by** push: *"Funke is on Emmanuel. Hold for now."* Their rows stay open in case Funke can't make it.
- When one agent marks **Delivered**, the others' rows auto-cancel and they get a **Delivery closed** push. Only the winning agent's stock decrements; the client is billed once.
- If you add a late duplicate (say, a 4th agent at 11am after Funke went en-route at 10am), that new agent is told to stand by immediately on creation.
- The 9pm auto-rollover dedups too: if none of the duplicates won today, only the oldest rolls forward to the next workday; the rest are cancelled.

You don't need to remember to cancel anything yourself. If the agents have **different phone numbers, addresses, or quantities**, the app treats them as separate orders (not siblings), so legit repeat orders are safe.`,
  },
  {
    id: 'reconcile',
    title: 'Reconcile — end of day money check',
    icon: 'wallet',
    body: `Open the app any time after 7pm.

### Check by-client

- Tap **Reconcile** (wallet icon in the tab bar). Defaults to **Today**.
- Use the chip row to switch to **Yesterday** / **Last 7 days** / **Custom** when you need a different window.
- Stay on **By client**. The big number is *Total remit owed* — what Reda collectively owes its clients today (paid − Reda's delivery fees).
- Tap any client row → opens that client's per-delivery report. You see: *customer paid*, *Reda delivery fee*, and *remit to you*, plus a line for each delivery showing how each was paid + the Reda fee + the per-trip remit.
- Tap **Share with client** to open the share menu — pick WhatsApp and send the report straight to the client.

### Check by-agent

- Tap **By agent**. This view is about money coming *in* from riders, not what you pay them.
- The big number is *Total to collect from agents* — the total cash riders owe Reda for the period so you can remit clients.
- The number next to each agent is *To remit* — what that rider needs to send Reda: what they collected from customers minus the rider's own delivery pay (they keep their pay). Tap a row to see the breakdown (collected → rider pay → to remit).
- A red number means Reda owes the rider (their pay was more than they collected — e.g. unpaid/partial deliveries).
- If an agent says "I delivered to X but it's not here", they forgot to mark it delivered in the app. Tell them to open it now.

### Check the daily summary (Reda's own P&L)

- Tap **Summary** (third tab).
- Shows: deliveries count, customer paid, Reda-side totals (delivery fee collected / remit owed to clients / agent payments) and **Reda margin** = delivery fee − agent payments.
- Tap **Share summary** to send the day's numbers out of the app (to yourself on WhatsApp, for your own records).`,
  },
  {
    id: 'eod',
    title: 'End of day — auto-rollover at 9pm',
    icon: 'calendar',
    body: `At **9pm Lagos every night**, the app rolls every still-pending delivery forward to the next working day automatically. You don't have to remember. You'll get a push that says either:

- **"Rolled N deliveries forward. Tap to review."** — the cron found stuck rows and rolled them.
- **"All clear — nothing to roll."** — your team finished everything for the day.
- **"Auto end of day FAILED"** — something went wrong. Open the EOD screen and tap **Roll all forward** to do it manually.

**Sundays are skipped.** Saturday's pending deliveries land on Monday automatically.

### If you want to do it yourself

- Go to **Home → End of day** (calendar icon in Quick Actions).
- Anything in the list is a delivery that didn't close out for that date.
- Tap **Roll N forward**. Same effect as the 9pm cron — the original delivery is closed (marked as *rolled over*), and a fresh one for the same customer is opened for the next working day.

### Looking back

If you want to see what got rolled (or any other past date), go to **Deliveries** and tap the **Yesterday** chip at the top. **Custom** lets you type any date. **All dates** shows everything across history.`,
  },
  {
    id: 'fix-delivery',
    title: 'Fix a wrong delivery',
    icon: 'edit',
    body: `If a delivery has the wrong status / quantity / payment:

1. **Deliveries** tab → tap the delivery.
2. Tap **Update status** (or **Mark delivered** if it should be delivered).
3. Pick the new state. For delivered, you also enter qty + amount + cash/transfer.
4. Save. The change is recorded in the history — anyone can see who changed what.

### Fix a typo before it's delivered

If you spotted a wrong name, phone, address, product, quantity or price, tap the **edit** icon in the top-right of the delivery screen. Change what's wrong, **Save changes**. Only works while the delivery is still open — once it's delivered, cancelled, or otherwise closed, the edit icon disappears and you'll have to fix things via a new delivery.

If someone else is already editing the same delivery, you'll see *"<Name> is editing this"* with a **Take over** button — only use Take over if you're sure they've stopped.

### Claim a customer follow-up

When an agent flags a delivery as **Not picking / Number busy / Switched off / Tomorrow / Postponed / Follow up**, the customer needs a call from you or a dispatcher. To avoid two of you calling the same customer:

- Open the delivery → tap **I'll handle this** on the yellow "Needs follow-up" banner.
- Other admins/dispatchers will see *"<Your name> is handling this"* both on the delivery and in the deliveries list (small badge next to the status pill).
- Tap **Release** when you're done, or just change the status — the claim drops automatically the moment the status changes.

As admin you can change anything. Agents can only push a delivery forward (mark it delivered or report an issue) — they can't undo.

### Agent flagged something? Open issues from agents

When an agent taps the alert icon on a delivery (wrong address, can't reach customer, payment dispute, product issue, other) you get a push titled **"Issue flagged"** and the delivery shows up in the **Open issues from agents** block on the home screen.

- Tap the row → opens the delivery. The agent's message is at the bottom with the issue chip + their note.
- Type your reply in the composer and tap **Send** — the agent gets a push titled **"Reply from {your name}"**.
- The flag also moves the delivery into a soft status (usually **Follow up** or **Not picking**), so the **I'll handle this** claim button is right there if you want to call the customer yourself.
- The issue row disappears from the home block as soon as you open the delivery (it's marked read on focus). When the delivery is closed (delivered / cancelled / etc.) the thread closes itself.

### The deliveries list order

The list shows non-completed deliveries first, sorted by **most recent status change** at the top. Whatever just moved (just flagged, just marked Not picking, just transitioned) bubbles up. Completed/closed deliveries fall to the bottom.`,
  },
  {
    id: 'review',
    title: `Review the bot's parses`,
    icon: 'bot',
    body: `If the bot is turned on (Paschal controls this):

- **Review** tab in the bottom bar shows what the bot has done with the WhatsApp messages.
- *Needs Review* — the bot couldn't figure out the address or the product. **Tap any row** to open the fix screen: everything the bot already read is pre-filled, you just pick the missing piece (usually a location, sometimes the right client when two carry the same product). Tap **Create delivery** and the order is in. Tap **Discard** instead with a reason (Spam / Duplicate / Not a real order) if it shouldn't become a delivery.
- *Shadow* — what the bot would have created if we had let it. Useful to check it's reading messages correctly before we let it create deliveries on its own.
- *Errors* — the bot couldn't read the message, or the phone lost signal. Usually a one-off; tap to see what went wrong.

If someone else is already fixing the same row, you'll see *"<Name> is fixing this"* with a **Take over** button — only use Take over if you're sure they've stopped.`,
  },
  {
    id: 'stock',
    title: 'Stock — receive, transfer, adjust',
    icon: 'warehouse',
    body: `- **Stock** (warehouse icon, under Home → Quick Actions).
- Top of the screen has three buttons: **Receive stock** (the big red one), **New transfer**, **Adjustment**.
- The list below has two tabs:
  - **By holder** (default) — the warehouse is always shown at the top (even when empty), then each agent. Red number = below zero (problem). Yellow number = 3 or fewer left, running low.
  - **By client** — totals per client. Each card shows how many products that client has with Reda, and how that splits between the warehouse and the agents. Tap a client to see each of their products with the same breakdown, plus a **Share with client** button (sends a summary via WhatsApp).

### Receive stock (vendor intake)

- Top of stock page → **Receive stock**.
- Where it's going is set to **Shomolu warehouse** by default. Only switch to an agent for the rare case where a vendor drops stock straight to an agent in the field (stock usually goes to the warehouse first).
- Add one row per item received: pick the client → product → quantity.
- **+ Add another item** to record several products at once (when a vendor drops more than one product).
- Optional **Notes** at the bottom for all the rows (invoice number, "Aernings May restock", etc.).
- Tap **Record N items**. Each row is saved on its own — if one row has bad info, the others still go through.

### Move stock between two people

- **New transfer**.
- Pick reason:
  - **Warehouse issue** (Warehouse → Agent) — for giving stock out in the morning. Pick the warehouse once, then add one row per agent + product + quantity. Submit "Issue N transfers" and they all go out at once.
  - **Warehouse return** (Agent → Warehouse) — same layout, for stock agents bring back at the end of the day.
  - **Transfer** (Agent ↔ Agent) — one row at a time, for the less common case (e.g. Funke handing off to Audrey because Funke is off tomorrow).
- For every row, the stock leaves one person and arrives with the other in one step — a transfer is never half-done.

### Adjustment (write-offs and corrections)

- **Adjustment** button.
- Reasons available:
  - **Loss / theft / damaged** — write the stock off (the number goes down).
  - **Found** — add stock back (the number goes up).
  - **Correction** — use this when an old number was wrong. Can go either way (e.g. add 2 to clear a balance that's stuck at minus 2).
- *Bulk intake* is **not** in this picker any more — use **Receive stock** at the top of the page instead.

### See how much of a client's product Reda holds

- Stock screen → **By client** tab → tap the client → see each of their products with how much is at the warehouse and how much is with agents. Tap **Share with client** to send the breakdown via WhatsApp.
- Or: **Catalog → Clients → that client → View stock** lands you in the same screen.`,
  },
  {
    id: 'troubleshooting',
    title: 'When something seems broken',
    icon: 'alert',
    body: `Pause. Open WhatsApp. Tell Paschal:

> "Reda app, [thing you tried], [what happened]"

Don't try to fix it in the moment. The Google Sheet is still your backup for now (Make.com keeps writing to it). Once we stop using the sheet, falling back means re-entering by hand once the app is fixed.

### Checking against the sheet (during the changeover)

While the Google Sheet is still running as a backup:

- Compare today's reconcile totals to the sheet's tab for the same day.
- If they match: great, do nothing.
- If they don't match: figure out which one is wrong. For new deliveries, the **app** is the one to trust. For old deliveries (added before we moved everything into the app), trust the **sheet** while we're still running both side by side.

After about 5 days in a row of matching numbers, tell Paschal — he'll close the sheet for editing.`,
  },
] as const satisfies readonly HelpSection[];

const AGENT = [
  {
    id: 'sign-in',
    title: 'Sign in & unlock',
    icon: 'user',
    body: `- Open the app, enter your email and password. Tap the eye to peek at the password.
- Forgot it? Tap **Forgot password** on the login screen — a reset link is mailed to you. Click the link, set a new password.
- After signing in once, the app remembers your email so you only type the password next time.
- (Optional) **Profile → Unlock with Face ID / Fingerprint** — turn this on and the app asks for your face or finger every time you open it. Extra lock on the door so a borrowed phone can't peek at your deliveries.`,
  },
  {
    id: 'today',
    title: 'Today — your stops for the day',
    icon: 'truck',
    body: `- The home screen lists every delivery assigned to you today, most urgent first.
- The two boxes at the top show **Earned today** (your share of what's been delivered) and the **delivered / total** count. The price for each stop is on its card — that's what you ask the customer for.
- Tap any card to open the delivery: customer name, phone, address, product, quantity, agreed price.
- Tap the phone icon on the detail screen to call the customer. Tap the map pin to open the address in your maps app.

### Stand by + Delivery closed pushes

Sometimes Reda assigns the same delivery to a few of you so whoever gets there first delivers it. The app coordinates:

- **Stand by — Funke is on Emmanuel. Hold for now.** Another agent just marked en-route. Don't call the customer yet; wait. Your row stays open in case Funke can't make it.
- **Delivery closed — Funke delivered to Emmanuel. Your row is closed.** Another agent already delivered. You don't need to do anything — the row is now cancelled in your list and Reda knows.

Treat both as "stand down" signals. You'll still see the row in your Today, just with the appropriate status pill (still open after Stand by; cancelled after Delivery closed).`,
  },
  {
    id: 'mark-delivered',
    title: 'Mark a delivery delivered',
    icon: 'check',
    body: `Open the delivery → tap **Mark delivered**:

1. Enter the **quantity** you actually dropped off (defaults to the ordered qty).
2. Enter the **amount collected** in naira.
3. Pick **Cash** or **Transfer**.
4. Submit.

The delivery turns green and your **Earned today** ticks up. You can't change a delivered delivery — if you made a mistake, message Reda to get it fixed.`,
  },
  {
    id: 'report-issue',
    title: `Report an issue (couldn't deliver)`,
    icon: 'alert',
    body: `If the delivery didn't go through, tap **Update status** instead of Mark delivered:

- **Not picking / Number busy / Switched off** — phone problems. Try again later in the day; the delivery stays open.
- **Tomorrow / Postponed / Follow up** — customer rescheduled. The delivery stays open but moves down your list.
- **Failed delivery** — you went, customer refused or wasn't there. Closed.
- **Unserious** — customer wasted your time. Closed.
- **No product** — you don't have the product. Tell Reda so they can re-assign or send stock.

Every status change is recorded. Reda sees it straight away.

### Flag something specific for Reda or a dispatcher

The red **alert** icon in the top-right of a delivery is for when you need ops to step in — wrong address, can't reach the customer, payment dispute, etc.

1. Tap the **alert** icon.
2. Pick the issue chip (e.g. *Wrong address*, *Can't reach client*, *Payment dispute*, *Product issue*, *Other*) → optional note ("address is in Lekki not VI, customer said over the phone").
3. **Send to ops** — one tap does two things: opens a chat thread on this delivery AND sets the status (e.g. *Can't reach client* → *Not picking*). You don't need to also tap Update status.

Reda and the dispatchers get a push, see the issue at the top of their list, and reply right inside the delivery — you get a push back. The thread stays visible on the delivery detail until the delivery is delivered/cancelled/etc.; then it closes automatically.`,
  },
  {
    id: 'end-of-day-return',
    title: 'End of day — return unsold stock',
    icon: 'arrowDown',
    body: `When you're done for the day:

- If you have unsold stock from the warehouse, drop it back at Shomolu and tell Reda so they can record the **Warehouse return** in the app.
- Open deliveries you couldn't finish stay on your list for tomorrow (Reda will roll them forward).
- If you want, check your **Earnings** tab to see what you'll be paid today.`,
  },
] as const satisfies readonly HelpSection[];

const DISPATCHER = [
  {
    id: 'sign-in',
    title: 'Sign in',
    icon: 'user',
    body: `- App icon → enter your email and password. Tap the eye icon to peek at the password.
- Forgot password? Tap **Forgot password** on the login screen and follow the email link.
- (Optional) **Profile → Unlock with Face ID / Fingerprint** — extra check so the app asks for your face or finger every time you open it.`,
  },
  {
    id: 'review',
    title: `Review what the bot couldn't parse`,
    icon: 'bot',
    body: `- Tap **Review** in the bottom bar.
- *Needs Review* — the bot couldn't figure out the address or the product. **Tap any row** to open the fix screen with the original message at the top and a pre-filled form below. Usually you just need to pick a location, or (when two clients carry the same product) pick the right client from the chips at the top. Tap **Create delivery** and the order is in. Tap **Discard** if it's spam, a duplicate, or not a real order.
- *Shadow* — what the bot would have created. A good place to check that it's reading messages correctly before we let it create deliveries on its own.
- *Errors* — the bot couldn't read the message, or the phone lost signal. Usually a one-off; ignore unless the same row fails twice.

If someone else is already fixing the same row, you'll see *"<Name> is fixing this"* with a **Take over** button — only use Take over if you're sure they've stopped.`,
  },
  {
    id: 'new-delivery',
    title: 'Create a delivery manually',
    icon: 'plus',
    body: `From **Deliveries → +** or from a Review item:

1. Customer name, phone, address.
2. Pick the client chip → pick the product.
3. Quantity + customer price.
4. Leave **Location** blank if you're not sure — it'll appear in Review so it can be sorted out later.
5. Leave **Agent** blank and the app picks the right one. Only pick a specific agent if you want to override that.
6. **Create delivery**. The agent gets a notification on their phone.`,
  },
  {
    id: 'assign',
    title: 'Assign or re-assign a delivery',
    icon: 'users',
    body: `- Open any delivery from the **Deliveries** tab.
- Tap **Re-assign** → pick the new agent → confirm.
- If the new agent doesn't have the product on them, the app does **not** block you. Instead it tells the agent to pick up from the warehouse, and tells the admin so we can make sure that happens.
- Agents only see deliveries assigned to them. Admins, dispatchers, and reps see everything.

### Claim a customer follow-up

If an agent reports the customer didn't answer / asked for tomorrow / etc., open the delivery and tap **I'll handle this** before you reach for WhatsApp. The rest of the team will see *"<Your name> is handling this"* and stay out of your way. The claim drops automatically the moment the status changes; you can also tap **Release** if you're stepping away.`,
  },
] as const satisfies readonly HelpSection[];

const WAREHOUSE = [
  {
    id: 'sign-in',
    title: 'Sign in',
    icon: 'user',
    body: `- App icon → enter your email and password. Tap the eye to peek at what you typed.
- Forgot password? Use **Forgot password** on the login screen.
- (Optional) **Profile → Unlock with Face ID / Fingerprint** — extra check so the app asks for your face or finger every time you open it.`,
  },
  {
    id: 'receive-stock',
    title: 'Receive stock from a vendor',
    icon: 'arrowDown',
    body: `When a vendor drops off product at the warehouse:

1. **Stock → Receive stock**.
2. Where it's going is set to **Shomolu warehouse** by default — leave it.
3. Add a row for each product: client → product → quantity.
4. Tap **+ Add another item** when there's more than one product.
5. Add a note at the bottom if useful (invoice number, vendor name).
6. Tap **Record N items**. Each row is saved on its own — one bad row doesn't block the others.

The warehouse total in the **By holder** tab goes up straight away.`,
  },
  {
    id: 'issue-stock',
    title: 'Issue stock to agents',
    icon: 'arrowRight',
    body: `When an agent comes to pick up stock for the day:

1. **Stock → New transfer**.
2. Pick reason **Warehouse issue** (Warehouse → Agent).
3. Add a row for each agent + product + quantity. You can give stock to several agents in one go.
4. Tap **Issue N transfers**.

For an agent bringing unused stock back at end of day, use **Warehouse return** instead. It looks the same, just in the other direction.`,
  },
] as const satisfies readonly HelpSection[];

/**
 * The single source of truth for help / runbook content. The
 * `reda_admin_runbook.md` file is generated from `ADMIN` by
 * `scripts/build-runbook.mjs` — do not edit the .md by hand.
 */
// `rep` is a dispatcher variant with no stock access — the operational
// workflow is identical, so the help content reuses DISPATCHER, plus a
// rep-only reconcile topic. The rep reconcile screen is deliberately
// fee-free, so this copy must NOT mention the Reda fee, margin, agent
// payroll or the by-agent / summary views (which reps don't have).
const REP = [
  ...DISPATCHER,
  {
    id: 'reconcile',
    title: 'Client updates — what was delivered',
    icon: 'wallet',
    body: `Send a client the list of what was delivered for them and what Reda will remit.

- Tap **Reconcile** (wallet icon in the tab bar). Defaults to **Today**.
- Use the chip row to switch to **Yesterday** / **Last 7 days** / **Custom** for a different window.
- The big number is *Total to remit* — what Reda will send across all clients for the period.
- Tap any client row → opens that client's per-delivery list: each delivery's customer, product, quantity delivered, and the amount to remit. A note flags a short delivery.
- Tap **Share with client** → pick WhatsApp and send the report straight to the client.`,
  },
] as const satisfies readonly HelpSection[];

export const HELP_BY_ROLE = {
  admin: ADMIN,
  agent: AGENT,
  dispatcher: DISPATCHER,
  rep: REP,
  warehouse: WAREHOUSE,
} as const satisfies Record<Role, readonly HelpSection[]>;

/**
 * Union of every section id across every role. Use as the type for the
 * AppBar's `helpTopic` prop and the deep-link `topic` param so typos fail at
 * compile time.
 */
export type HelpTopic = (typeof HELP_BY_ROLE)[Role][number]['id'];
