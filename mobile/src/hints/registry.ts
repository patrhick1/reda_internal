// Typed registry of every in-app hint id. Adding a new hint:
//   1. Add an id here.
//   2. Drop a `<Hint id={HINTS.MY_NEW_HINT}>...</Hint>` wherever it should
//      appear.
//   3. The dismiss-flag, the persistence key, and the Profile reset path all
//      pick it up automatically.
//
// The string values are stable identifiers — they appear inside AsyncStorage
// keys (`reda.hint.<id>.<userId>`). Renaming a string strands existing
// dismissals; do that deliberately if you really want users to see a hint
// again under a new id.

export const HINTS = {
  /** First time on a screen with a helpTopic AppBar icon — points out the
   *  `?` button in the top-right. Single id; dismissing on one screen kills
   *  it across all `helpTopic` screens. */
  HELP_ICON_DISCOVERY: 'help-icon-discovery',

  /** Soft-status delivery detail — teases the "I'll handle this" claim
   *  button so peers know to stand down. Suppressed once someone has
   *  claimed (the existing FollowupClaimBanner says enough). */
  FOLLOWUP_CLAIM: 'followup-claim',

  /** Needs Review tab with ≥1 row — teaches that rows are tappable to fix
   *  the missing piece + create the delivery. */
  REVIEW_TAP_TO_OPEN: 'review-tap-to-open',

  /** Pre-delivery detail with the edit icon visible — teaches that customer
   *  name / phone / address / etc. can be edited before delivery. */
  EDIT_DELIVERY_ICON: 'edit-delivery-icon',
} as const;

export type HintId = (typeof HINTS)[keyof typeof HINTS];
