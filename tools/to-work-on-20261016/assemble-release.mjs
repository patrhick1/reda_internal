import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const src = process.cwd();
const dest = 'C:/Users/ebube/.codex/worktrees/to-work-on-release/Reda-dev';
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dest, encoding: 'utf8' }).trim(), '');
execFileSync('git', ['switch', '-c', 'codex/to-work-on-abcd'], { cwd: dest });
const copy = file => {
  mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
  copyFileSync(path.join(src, file), path.join(dest, file));
};
for (const file of [
  'mobile/app/(admin)/index.tsx',
  'mobile/src/lib/delivery-order.ts', 'mobile/src/lib/delivery-order.test.mjs',
  'supabase/functions/bot-parse-message/index.ts',
  'supabase/functions/_shared/bowan-quantity.ts', 'supabase/functions/_shared/bowan-quantity.test.ts',
  'supabase/migrations/20261016190000_rollover_attempt_count.sql',
  'tools/live-defs/rollover_delivery_before_attempt_fix_20261016.sql',
  'tools/live-defs/maintenance_classify_before_attempt_fix_20261016.sql',
  ...['README.md', 'parser-acceptance.test.ts', 'ui-acceptance.mjs', 'attempts-regression.sql', 'attempts-acceptance.sql', 'attempts-policy.sql', 'assemble-release.mjs'].map(f => 'tools/to-work-on-20261016/' + f),
]) copy(file);
function edit(file, changes) {
  const target = path.join(dest, file);
  let text = readFileSync(target, 'utf8');
  for (const [before, after] of changes) {
    assert(text.includes(before), file + ' missing anchor: ' + before.slice(0, 90));
    text = text.replace(before, after);
  }
  writeFileSync(target, text);
}
edit('mobile/src/screens/deliveries/List.tsx', [
  ["import { formatNaira, formatYmdShort } from '@/lib/format';", "import { formatNaira, formatYmdShort } from '@/lib/format';\nimport { compareDeliveryActivity } from '@/lib/delivery-order';"],
  ['return extra.length > 0 ? [...buckets.all, ...extra] : buckets.all;', 'return extra.length > 0\n      ? [...buckets.all, ...extra].sort(compareDeliveryActivity)\n      : buckets.all;'],
]);
edit('mobile/src/services/deliveries.ts', [
  ["import { formatDayMonthLagos } from '@/lib/date';", "import { formatDayMonthLagos } from '@/lib/date';\nimport { compareDeliveryActivity } from '@/lib/delivery-order';"],
  ["return rows.sort((a, b) => {\n    const x = a.activity_at ?? a.created_at ?? '';\n    const y = b.activity_at ?? b.created_at ?? '';\n    return x < y ? 1 : x > y ? -1 : 0; // most-recent activity first\n  });", 'return rows.sort(compareDeliveryActivity);'],
]);
edit('tools/eod-reliability-20260921/test-runner.mjs', [
  ["    '20261016200000_disable_delivered_notifications.sql',", "    '20261016190000_rollover_attempt_count.sql',\n    '20261016200000_disable_delivered_notifications.sql',"],
  ["'test-simple-workflows.sql']", "'test-simple-workflows.sql','../to-work-on-20261016/attempts-regression.sql','../to-work-on-20261016/attempts-acceptance.sql','../to-work-on-20261016/attempts-policy.sql']"],
]);
edit('tools/eod-reliability-20260921/test-maintenance.sql', [
  ["scheduled_date=public._ensure_workday(target) AND rollover_count=1)\n  FROM deliveries WHERE parent_delivery_id=md5('eod-test-order-2')::uuid),'missed days produce one actionable child'", "scheduled_date=public._ensure_workday(target) AND rollover_count=0)\n  FROM deliveries WHERE parent_delivery_id=md5('eod-test-order-2')::uuid),'missed Pending days produce one actionable child without consuming an attempt'"],
]);
edit('mobile/package.json', [
  ['    "test:delivery-payment":', '    "test:delivery-order": "node --experimental-strip-types --test src/lib/delivery-order.test.mjs",\n    "test:delivery-payment":'],
]);
edit('.github/workflows/ci.yml', [
  ['      - name: Urgent stock and Altior regression tests', '      - run: npm run test:delivery-order\n      - name: Urgent stock and Altior regression tests'],
  ['      - name: Stock refresh and Altior report acceptance', `      - name: Postponed ordering and admin departure acceptance
        run: node ../tools/to-work-on-20261016/ui-acceptance.mjs
        env:
          REQUEST_UI_DIST: dist
          PLAYWRIGHT_MODULE_PATH: \${{ runner.temp }}/eod-browser/node_modules/playwright
      - name: Stock refresh and Altior report acceptance`],
  ['tools/urgent-ab-20261016/parser-acceptance.test.ts supabase/functions/_shared/product-hint.test.ts', 'tools/to-work-on-20261016/parser-acceptance.test.ts supabase/functions/_shared/bowan-quantity.test.ts tools/urgent-ab-20261016/parser-acceptance.test.ts supabase/functions/_shared/product-hint.test.ts'],
]);
if (!existsSync(path.join(dest, 'mobile/node_modules'))) {
  execFileSync('powershell', ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path '${dest}/mobile/node_modules' -Target '${src}/mobile/node_modules' | Out-Null`]);
}
console.log('A–D assembled on current main; current phone search, closures, notifications and other released behavior preserved.');
