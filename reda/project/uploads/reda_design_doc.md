# Reda Internal App — Design Doc

A design direction document for the Reda Logistics internal team app. Built from Reda's existing brand assets. For Uzo to review and Paschal to build from.

This doc covers *how the app should look and feel* — not what it does (that's in the system design doc and PRD).

---

## 1. The brand as I read it

Reda's existing brand has three things working for it:

1. **A disciplined three-color palette** — red, black, white. Most small brands sprawl. Reda's restraint is a strength.
2. **A logo that earns its place** — the R is built from a 3D box with an arrow cutout. It tells you what Reda does without words.
3. **A direct, confident voice** — "Fast. Reliable. Last mile, done right." Short sentences. Red used for emphasis, not decoration.

The brand feels operational, not corporate. Agents wear it. Bikes carry it. It's a working brand for a working business.

The app should match this — but **dialed down for daily use.** Marketing materials can have motion blur and exclamation marks. The app needs to be calm, fast, and confidence-inspiring at 9pm after a long delivery run. Same brand DNA, lower intensity.

---

## 2. Color system

| Role | Color | Hex | Where it's used |
|---|---|---|---|
| Brand red | Vivid red | `#E63027` | Primary actions, active states, accents, alerts |
| Brand black | Near-black | `#0A0A0A` | Primary buttons, body text, headings |
| Brand white | Pure white | `#FFFFFF` | Backgrounds, contrast surfaces |
| Surface gray | Light gray | `#F5F5F5` | Card backgrounds, section dividers |
| Border gray | Mid-light gray | `#E5E5E5` | Borders, dividers, inactive states |
| Text gray | Mid gray | `#7A7A7A` | Secondary text, metadata, timestamps |

### Functional extensions (not brand colors, but needed for clarity)

| Role | Color | Hex | Where |
|---|---|---|---|
| Success green | Forest green | `#16A34A` | "Delivered" status, success confirmations |
| Warning amber | Amber | `#F59E0B` | Soft-failure statuses (Number Busy, Tomorrow, etc.) |
| Closed gray | Gray | `#7A7A7A` | Terminal failure statuses (Cancelled, Unserious) |

**Note for Uzo:** I added green for "Delivered" because users need to instantly distinguish success from failure, and Reda's brand doesn't have a success color. If you'd rather keep it strictly black-on-white (using a checkmark icon instead of a color), say the word and I'll swap it.

### Color rules

1. **Red is for emphasis, not surfaces.** Use it for buttons, badges, active states. Don't make whole screens red — it'll feel aggressive.
2. **Black is the primary action color.** "Submit," "Save," "Mark Delivered" use black buttons. Red is reserved for emphasis moments and brand accents.
3. **Avoid color combinations not in the system.** No bright blues, purples, teals. If something needs differentiation, use shade not hue.
4. **Status colors are functional.** Green for success, amber for soft fail, gray for closed. Same colors mean same things across the app.

---

## 3. Typography

**Font family:** Montserrat (close match to the existing logo). Free on Google Fonts, works well on Android.

If Reda's designer used something different (Poppins, Raleway, Bebas Neue), we'd switch to match — easier to align than to fight the brand.

### Type scale

| Style | Size | Weight | Use |
|---|---|---|---|
| Display | 28px | Bold | Splash screens, key brand moments |
| Heading 1 | 22px | Bold | Screen titles |
| Heading 2 | 18px | SemiBold | Section headers |
| Heading 3 | 16px | SemiBold | Card titles, list section headers |
| Body | 15px | Regular | Default text |
| Body emphasis | 15px | SemiBold | Important values (amounts, names) |
| Caption | 13px | Regular | Metadata, timestamps, helper text |
| Small | 11px | SemiBold | Pills, labels, badge text |

### Typography rules

1. **Lean larger than typical.** Agents use this in bright Lagos sun on cheap phones. Default body is 15px, not the iOS-standard 14px.
2. **Bold the values, not the labels.** "Customer: **Adegboye Akoro**" — the name is the data, it gets weight. The word "Customer:" is just a hint.
3. **Currency always with ₦ symbol.** Never just numbers without context. "₦19,000" not "19,000."
4. **Avoid all-caps in UI.** The logo uses all-caps for the brand name; the app should use sentence case for everything else. All-caps is harder to read.

---

## 4. Spacing & layout

### Spacing scale

Use multiples of 4px. Predictable, easy to remember:
- 4px — tight (icon to label)
- 8px — small (within a card)
- 12px — medium (between related items)
- 16px — standard (default padding)
- 24px — large (between sections)
- 32px — extra large (top of screens)

### Tap targets

**Minimum 48px height for any tappable element.** Agents are using this with sweaty thumbs in bright sunlight. Generous targets prevent mis-taps. This is bigger than iOS's 44px recommendation — deliberate.

### Screen padding

- 16px horizontal padding on screens
- 16px between cards in a list
- 24px below screen header before content starts

---

## 5. Components

### Buttons

**Primary (black):**
- Background: `#0A0A0A`
- Text: `#FFFFFF`
- Used for: main actions ("Save," "Create Delivery," "Confirm")
- Height: 48px, fully rounded corners (or pill shape — match the existing Reda style)

**Emphasis (red):**
- Background: `#E63027`
- Text: `#FFFFFF`
- Used for: brand moments, "Mark Delivered" (the satisfying action of completing a delivery)
- Same dimensions as primary

**Secondary (outlined):**
- Background: `#FFFFFF`
- Border: 1.5px `#0A0A0A`
- Text: `#0A0A0A`
- Used for: alternatives ("Cancel," "Reassign")

**Destructive (warning):**
- Background: `#FFFFFF`
- Border: 1.5px `#E63027`
- Text: `#E63027`
- Always paired with a confirmation modal. Never one-tap destruction.

### Cards

White background, subtle shadow, 12px rounded corners. No borders — let the shadow do the work. Cards group related info (one delivery, one agent, one client). Tap to expand or open detail screen.

Internal padding: 16px. Title at top in Heading 3, body content below.

### Status pills

Small rounded pills, 24px tall, 12px horizontal padding, 11px SemiBold text. Color-coded:

- **Available / Pending:** red background, white text — "active, needs attention"
- **Soft failures:** amber background, white text — "needs follow-up"
- **Delivered:** green background, white text — "done, success"
- **Cancelled / Closed:** gray background, white text — "closed, no action"

Pill text uses sentence case, short: "Delivered," "Number busy," "Tomorrow."

### Inputs

Single bottom border style, not full rectangle. Cleaner on mobile.

- Default: 1px `#E5E5E5` bottom border
- Focused: 2px `#E63027` bottom border (red brand accent on focus)
- Error: 2px `#E63027` bottom border + helper text in red below
- Label sits above the input, in 13px gray (`#7A7A7A`)
- Placeholder text in the field itself, 15px regular `#7A7A7A`

### Lists

Each list item:
- 16px vertical padding (so item height ≈ 72px when including content)
- 16px horizontal padding
- 1px `#E5E5E5` bottom divider (last item omits divider)
- Tap area is the full row

### Status timeline (delivery history)

For the audit trail on a delivery detail screen:

- Vertical timeline with dots
- Each entry: timestamp on the left (gray), status pill in center, user name + reason on the right
- Most recent at the top
- Dots colored per status pill colors

This makes the audit visible at a glance.

---

## 6. Imagery & iconography

### Icons

Use a consistent icon set. Recommend **Phosphor Icons** or **Lucide** (both free, both have React Native versions, both have the right modern-but-not-trendy look).

Icon weight: regular for body usage, bold for buttons. 24px default, 20px in dense lists, 32px in empty states.

### Avatars / agent representation

For agent profile photos: 40px circles. If no photo, use initials on a colored background (one of: red, black, gray — alternating, deterministic by user ID).

### Logo usage

- Login screen: full color logo, centered, ~120px wide
- Top nav header: small logomark (just the R cube) at 32px, on black or white background
- Loading states: subtle pulse on the logomark
- Empty states: muted logomark at low opacity as a watermark

**Do not** stretch, recolor, or modify the logo. If you need a flat single-color version, use the existing white-on-black version.

---

## 7. Tone & voice

### UI copy rules

1. **Short and direct.** "Delivery assigned" not "A new delivery has been assigned to you."
2. **Verbs over nouns.** "Mark Delivered" not "Status Update."
3. **Concrete over abstract.** "₦19,000 collected from Adegboye" not "Payment recorded successfully."
4. **No corporate speak.** No "kindly," no "please ensure," no "in due course."
5. **Confirm meaningful actions.** "Mark this delivery as cancelled?" not "Are you sure you want to proceed?"

### Empty states

Empty states are a small brand moment. Warm but not chatty:

- "No deliveries today. Rest up."
- "Nothing in your stock yet."
- "No deliveries to review. Good work."

These can lean slightly into the Reda voice ("let's make it count" energy) without being sappy.

### Error messages

Honest about what went wrong, actionable about what to do:

- ❌ "An error has occurred. Please try again."
- ✅ "Couldn't save the status change. Check your connection and try again."

### Confirmations

After a successful action, brief confirmation:
- "Saved." (toast, 2 seconds)
- "Delivered. ₦19,000 recorded." (toast, 3 seconds for important context)

---

## 8. Screen patterns (what each screen feels like)

### Login screen

The first brand moment. Bold.

- Black background (full screen)
- Reda logo centered, full color, ~120px wide
- Below logo: tagline in white "Fast. Reliable. Last mile, done right." — 13px caption gray
- Bottom third of screen: white card with email field, password field, primary red "Sign in" button
- Optional: subtle motion or animation on the logo for warmth

This is the only screen where red gets a big surface (the button). After login, the app dials down.

### Agent home (today's deliveries)

The screen Kenneth sees every morning.

- White background
- Top bar: small Reda logomark on left, agent's name + current date on right
- Below: "X deliveries today, ₦Y to collect" — heading 2 summary in black
- List of deliveries, each a card:
  - Customer name (heading 3, black)
  - Address (body, gray) — tap to open in maps
  - Product × qty (body, black)
  - Status pill (top right)
  - Amount to collect (body emphasis, black) — only if not yet delivered
- Tap card → delivery detail

Sort: pending/available first, then soft failures, then delivered (delivered grouped at bottom).

### Delivery detail (agent view)

The screen where Kenneth marks things delivered.

- Header: customer name as heading 1, status pill below
- Tap-to-call phone button: full-width black button with phone icon "Call Adegboye" (uses customer name dynamically)
- Address card: address text + tap-to-open-in-maps secondary button
- Product card: product name, quantity, customer price
- Vendor card (compact): "Dentora" + the vendor notes shown prominently if non-empty ("Do not deliver partial orders…")
- Status timeline (history)
- Sticky bottom: red "Mark Delivered" emphasis button when in non-terminal state. When tapped, opens modal for quantity + payment + method.

### Admin dashboard

The screen Uzo opens first thing.

- Top: today's summary card — total deliveries, by-status counts, total volume in ₦
- Below: needs-attention list — Needs Review queue items, stale deliveries, low-confidence AI matches
- Below: quick actions — "Create delivery," "Reconciliation," "End of day"
- Tab bar at bottom: Home, Deliveries, Stock, Reconciliation, Settings

Default view is calm, not noisy. If there's nothing urgent, the screen is mostly empty — that's a good thing.

### Status update modal

When agent taps to change status:

- Slides up from bottom (modal, not full screen)
- Title: "Update status"
- List of valid next statuses (filtered by state machine)
- Each status: pill style + brief label
- If "Delivered" is selected: expands to show quantity delivered, paid amount, payment method (cash/transfer toggle)
- Sticky bottom: red "Confirm" emphasis button
- If transition requires a reason (backward correction by admin): reason field appears

Quick, no-nonsense. The whole interaction should be 5-10 seconds from tap to confirmation.

### Reconciliation view

For Uzo to see what's owed to whom.

- Two tabs: "By Client" and "By Agent"
- Date range picker at top (default: this week)
- List of clients (or agents), each row:
  - Client/agent name (heading 3)
  - Delivery count + total Remit/earnings (body emphasis)
  - Tap to expand → list of individual deliveries
- Floating action button (red): "Export" — though export itself is v2 scope

Numbers should be the hero of this screen — large, bold, easy to glance at.

---

## 9. Motion & feedback

Subtle, fast, functional. Not for show.

- Button press: 150ms scale to 0.97, then back
- Page transitions: 250ms slide
- Modals: 300ms slide-up from bottom
- Loading states: subtle skeleton screens or pulse on logomark
- Success toast: slide in from top, 2-3 seconds, then slide out
- Status pill on change: brief flash (200ms) then settle into new color

Avoid: bouncing animations, parallax, anything that delays the user from getting things done.

---

## 10. Accessibility

- All tap targets minimum 48px
- Color contrast: 4.5:1 minimum for body text, 3:1 for large text
- Don't rely on color alone for status — pair every status color with an icon or shape
- Support system font size (within reason — UI shouldn't break if user has accessibility text size enabled)
- Test in bright outdoor sunlight (Lagos midday) — if you can't read it on the street, it's not done

---

## 11. Implementation tokens

For the React Native build, all of the above translates to a single tokens file. Sketch:

```typescript
// src/theme/tokens.ts

export const colors = {
  brand: {
    red: '#E63027',
    black: '#0A0A0A',
    white: '#FFFFFF',
  },
  surface: {
    primary: '#FFFFFF',
    secondary: '#F5F5F5',
    border: '#E5E5E5',
  },
  text: {
    primary: '#0A0A0A',
    secondary: '#7A7A7A',
    inverse: '#FFFFFF',
  },
  status: {
    active: '#E63027',
    pending: '#F59E0B',
    success: '#16A34A',
    closed: '#7A7A7A',
  },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 24,
  xl: 32,
};

export const typography = {
  fontFamily: {
    heading: 'Montserrat-Bold',
    bodyBold: 'Montserrat-SemiBold',
    body: 'Montserrat-Regular',
  },
  size: {
    display: 28,
    h1: 22,
    h2: 18,
    h3: 16,
    body: 15,
    caption: 13,
    small: 11,
  },
};

export const radius = {
  sm: 6,
  base: 12,
  lg: 16,
  pill: 999,
};

export const tap = {
  minHeight: 48,
};
```

This becomes the single source of truth. Every component imports from here. When something needs tweaking — like if Uzo says "make the red slightly more orange" — one file changes and the whole app updates.

---

## 12. What I need from Uzo

Before this gets built, a few things would help confirm direction:

1. **Confirm the red.** Is `#E63027` accurate to your brand red? If you have an official hex value from your designer, share it. I matched by eye from the marketing image.

2. **Confirm the font.** I assumed Montserrat based on the logo's letterforms. If your designer used something else (Poppins, Raleway, etc.), tell me and I'll match.

3. **The logo as SVG.** PNG won't scale to all the sizes the app needs (app icon, push notification icon, splash screen). If you have the source SVG, share it. If not, the PNG I have can be vectorized.

4. **Green for "Delivered" — yes or no?** Brand has no green. I added it for clarity. If you'd rather stay strict black-on-white-with-red, I'll use a checkmark icon instead.

5. **Anything missing from the brand?** Marketing examples beyond the two images, brand guidelines doc if one exists, color names from Reda's designer — anything helps.

---

## 13. What this doc is and isn't

**Is:**
- A direction for visual and interaction design
- A reference Claude Code (or any builder) can pull from
- A starting point — gets refined as real screens get built

**Isn't:**
- A Figma file (we'll build to this, then iterate based on real usage)
- Final pixel-perfect mocks
- A constraint on creativity — if a real situation needs something outside this doc, deviate consciously and update the doc

---

*Last updated: this conversation. Should be reviewed against real screens once Milestone 1 of the build ships.*
