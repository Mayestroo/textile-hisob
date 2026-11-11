# Finance review — 216 adjustments and opening balances

Decision needed: **UNRESOLVED, not VERIFIED**. Phase 3 per-record inventory remains
authoritative: `evidence/phase3-historical-reconciliation.json` (216 IDs, exact original
quantity/provenance, missing links and reasons). No historical attribution was written.

## New original local artifacts examined in Phase 4

`evidence/phase4-local-historical-evidence.json` records hashes, schema/count inventory,
per-ID missing original fields and source-copy stability checks. Source SQLite was
never opened/migrated by the app: copied main/WAL/SHM files were inspected in disposable
directories. Source bytes were checked before/after; credentials/license files were
not read. This is additional evidence discovery, not business attribution certification.

- Installed `NovdaData/companies/comp_novda/hisob.sqlite`, v25: all 216 IDs present;
  81 matching retained outbox payloads. No complete original ticket/entry/period/rate
  linkage in these records or payloads.
- `comp_novda_before_reset/hisob.sqlite`, v19, and three named pre-fix v18 backups:
  31 matching IDs each, 9 matching command payloads each. These are overlapping
  copies, **not 124 new independent facts**. No complete original attribution.
- `comp_novda_before_1.1.7/hisob.sqlite`, v19: empty business tables; not financial proof.
- `hisob_database_comp_novda.json` and `backup_2026-11-09_08-35-36_w235.json`: no matching
  adjustment identity carrying the required original links. Workbook projections are
  not substitutes for immutable transaction attribution.
- None of the six SQLite main-file hashes matches the recorded original v15 source
  SHA `7db7b8f2cbf2c9104107ce2a29b5d1d71ce36bfd0ac6db57a1adc317eb9b75b3`.
- Targeted Desktop/Documents/Downloads discovery found audit fixtures, the preserved
  PG dump, tariff and November payroll exports. These do not establish each correction's
  original transaction or attest opening wages. Unrelated personal databases were not
  inspected. This was not an unrestricted full-disk or cloud/Telegram-history search.

Result remains **0 VERIFIED / 0 AMBIGUOUS / 216 UNRESOLVED**. A direct-link candidate
would still need exact tenant/worker/model/operation/quantity match and immutable
corroboration; none was found. Missing evidence is not evidence of fraud or cancellation.

## Required evidence per adjustment

Finance/record owner must return a review record keyed by the exact existing
`adjustmentId`, with:

1. Company and canonical worker/model/operation identity; explain any historic alias
   using retained identity records, not name similarity.
2. Original ticket ID and entry ID, original accounting period ID, correction reason
   and exact signed quantity. If an adjustment spans several original entries, supply
   the explicit allocation and approval; do not select a convenient single entry.
3. Original tariff snapshot, including explicit zero where genuinely agreed, and the
   immutable period/archive/rate evidence. Current tariff is not the historical proof.
4. Original source file/export or signed primary document, its SHA-256 and custody,
   plus a traceable immutable ticket/entry/archive reference. An accepted command hash
   proves acceptance, not that missing historical links were ever supplied.
5. Reversal relationship if applicable: exact original adjustment ID, inverse quantity,
   tenant/worker/operation/period agreement; don't infer reversal from net zero.
6. Approver identity, UTC review timestamp and disposition. Conflicting direct evidence
   becomes AMBIGUOUS, not guessed VERIFIED. Keep unresolved amounts NULL with reasons.

Engineering then checks the evidence and uses only an explicitly reviewed supported
reconciliation command. Do not UPDATE historical rows or reserialize frozen archives.

## Required opening-balance evidence

Obtain the original v15 SQLite including required WAL/backup provenance or an original
accountant-controlled ledger with verifiable equivalent facts. Reconcile by company,
worker and accounting period: earned/carry-forward wages, AVANS, JARIMA, salary,
shop deductions, paid amounts, closing/opening amount and effective date. Preserve
source hashes and an accountant/owner-approved bridge from raw legacy columns to
period facts. Worker staj is an attribute, not an automatically certified balance.

Raw retained totals (AVANS 2,020,000; JARIMA 550,000; staj 5,740,000) remain unchanged
and must not be added into a fictional opening wage. `HISTORICAL_BASELINE_UNVERIFIED`
stays visible until reviewed primary evidence establishes otherwise.

## Business decision alternatives

- **Full financial release:** verify all required attribution/opening balances and
  rerun independent validation and data-integrity evidence.
- **Explicit restricted scope:** accountable finance/business/release owners document
  exactly which prospective operations are permitted, how historical unresolved
  amounts remain visible, prohibited payroll/export/payment uses, operator messaging,
  and reconciliation plan. This is not granted here and must not silently change the
  existing full-scope gates to PASS.

Until one is approved, financial signoff remains release-blocking. Original rows,
historical amounts, tenant boundaries and archive digests must remain intact.
