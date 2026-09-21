"""Create a schema-only, offline test baseline; never copy production rows."""
import gzip
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source = root / '.codex-eod-test/local-schema.sql'
schema = source.read_text(encoding='utf-8-sig').replace('\r\n', '\n')
# Outbound integrations are unavailable in the fixture. Keep the notification
# transport shape so the migration exercises its real adapter against fake net.
schema = re.sub(r'(?ms)^CREATE FUNCTION public.send_edge_notification\(.*?(?=^--\n|\Z)',
    "CREATE FUNCTION public.send_edge_notification(p_body jsonb) RETURNS void LANGUAGE plpgsql AS $$ begin perform net.http_post(url:='http://isolated.invalid',headers:='{}',body:=p_body); end $$;\n\n", schema)
schema = re.sub(r'(?ms)^CREATE FUNCTION public.requeue_failed_inbound\(.*?(?=^--\n|\Z)',
    "CREATE FUNCTION public.requeue_failed_inbound(p_ids uuid[]) RETURNS integer LANGUAGE plpgsql AS $$ begin raise exception 'No external bot in tests'; end $$;\n\n", schema)
schema = re.sub(r"('x-internal-secret'\s*,\s*)'[^']*'", r"\1'isolated-test'", schema)
schema = re.sub(r'("x-internal-secret"\s*:\s*")[^"]*', r'\1isolated-test', schema)
schema = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', 'isolated-token', schema)
schema = re.sub(r'(?:sb_secret_|sk-)[A-Za-z0-9_-]{12,}', 'isolated-token', schema)
assert not re.search(r'(?m)^COPY |^INSERT INTO ', schema), 'Schema must contain no row data'
assert 'eyJ' not in schema, 'JWT remained in schema'
target = Path(__file__).parent / 'fixtures'
target.mkdir(exist_ok=True)
data = schema.encode()
(target / 'baseline.sql.gz').write_bytes(gzip.compress(data, mtime=0))
status = (root / '.codex-eod-test/status-data-local.sql').read_text(encoding='utf-8-sig')
(target / 'status-config.sql').write_text(status, encoding='utf-8')
(target / 'manifest.json').write_text(json.dumps({
    'source': 'Schema-only production snapshot, 2026-09-21; network functions sanitized',
    'uncompressed_sha256': hashlib.sha256(data).hexdigest(),
    'row_data': 'Only status definitions and transitions; no customer, order, user or financial rows',
}, indent=2) + '\n')
print('Sanitized schema fixture created:', len(data), 'bytes before compression')
