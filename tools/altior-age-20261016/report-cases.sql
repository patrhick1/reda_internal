BEGIN;
DO $$ BEGIN
  IF current_database() <> 'reda_altior_test' OR inet_server_addr() <> '127.0.0.1'::inet OR inet_server_port() <> 55459 THEN
    RAISE EXCEPTION 'Wrong test database';
  END IF;
END $$;
SET LOCAL test.actor='rep';
DO $$
DECLARE c uuid; actor text; r record;
BEGIN
  FOREACH actor IN ARRAY ARRAY['admin','rep'] LOOP
    PERFORM set_config('test.actor',actor,true);
    FOREACH c IN ARRAY ARRAY[
      '0b23954d-c5ea-49a1-ae67-f0b6ddf7a3cc'::uuid,
      '2acf7d84-3a5c-4532-b47c-568b7f4928f3'::uuid,
      '88398fcc-d4f7-4b5b-a16e-53ce5c463cf3'::uuid
    ] LOOP
      FOR r IN SELECT * FROM public.client_remit_detail_rep(c,'2026-10-15','2026-10-15') LOOP
        IF r.reda_fee IS DISTINCT FROM 2000 OR r.paid IS DISTINCT FROM (CASE WHEN r.payment_method='vendor_direct' THEN 0 ELSE 15000 END) THEN
          RAISE EXCEPTION 'Approved client payment/fee missing: %, %',c,r.payment_method;
        END IF;
        IF r.remit IS DISTINCT FROM (CASE WHEN r.payment_method='vendor_direct' THEN -2000 WHEN r.payment_method='cash' THEN 12500 ELSE 13000 END) THEN
          RAISE EXCEPTION 'Remittance changed';
        END IF;
        IF r.outstanding IS DISTINCT FROM (CASE WHEN r.payment_method='vendor_direct' THEN 0 ELSE 5000 END) THEN
          RAISE EXCEPTION 'Payment note behavior changed';
        END IF;
        IF r.cash_pos_fee IS DISTINCT FROM (CASE WHEN r.payment_method='cash' THEN 500 ELSE 0 END) OR r.quantity_delivered<>1 OR r.client_rep<>'ORD-TEST-001' THEN
          RAISE EXCEPTION 'Existing report fields changed';
        END IF;
      END LOOP;
      IF (SELECT count(*) FROM public.client_remit_detail_rep(c,'2026-10-15','2026-10-15'))<>3 THEN RAISE EXCEPTION 'Missing report rows'; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.client_remit_detail_rep('11111111-1111-4111-8111-111111111111','2026-10-15','2026-10-15') WHERE paid IS NOT NULL OR reda_fee IS NOT NULL) THEN
    RAISE EXCEPTION 'Payment or fee exposed for an unrelated client';
  END IF;
  IF EXISTS(SELECT 1 FROM public.client_remit_detail_rep('0b23954d-c5ea-49a1-ae67-f0b6ddf7a3cc','2026-10-16','2026-10-16')) THEN RAISE EXCEPTION 'Date range ignored'; END IF;
  PERFORM set_config('test.actor','agent',true);
  IF EXISTS(SELECT 1 FROM public.client_remit_detail_rep('0b23954d-c5ea-49a1-ae67-f0b6ddf7a3cc','2026-10-15','2026-10-15')) THEN RAISE EXCEPTION 'Upstream access filter bypassed'; END IF;
  IF has_function_privilege('altior_report_denied','public.client_remit_detail_rep(uuid,date,date)','execute') THEN RAISE EXCEPTION 'Denied role gained execution'; END IF;
  IF NOT has_function_privilege('altior_report_caller','public.client_remit_detail_rep(uuid,date,date)','execute') THEN RAISE EXCEPTION 'Existing grant lost'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS approved clients, unrelated-client redaction, payments/POS/remittance, quantities/references, date/access delegation, grants' AS result;
