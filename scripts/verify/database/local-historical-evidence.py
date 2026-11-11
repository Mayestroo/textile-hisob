"""Read additional business files only. Never opens source SQLite with SQLite itself:
copy main/WAL/SHM, verify source hashes unchanged, inspect disposable copy read-only.
No credentials/license/browser data; no business names/payloads in output.
"""
import hashlib
import json
import pathlib
import shutil
import sqlite3
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[3]
EXPECTED = '7db7b8f2cbf2c9104107ce2a29b5d1d71ce36bfd0ac6db57a1adc317eb9b75b3'


def sha(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def inspect_sqlite(file, expected_ids, scratch):
    related = [p for p in [file, pathlib.Path(str(file) + '-wal'), pathlib.Path(str(file) + '-shm')] if p.is_file()]
    before = {p.name: sha(p) for p in related}
    copydir = pathlib.Path(tempfile.mkdtemp(prefix='historical-copy-', dir=scratch))
    for source in related:
        shutil.copyfile(source, copydir / source.name)
    stable = all(p.is_file() and sha(p) == before[p.name] for p in related)
    result = {'path': str(file), 'sha256': before[file.name], 'matchesOriginalBaseline': before[file.name] == EXPECTED,
              'sidecars': {k: v for k, v in before.items() if k != file.name}, 'stableCopy': stable}
    if not stable:
        result['classification'] = 'UNSTABLE_SOURCE_NOT_EVIDENCE'
        return result
    db = sqlite3.connect((copydir / file.name).as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    try:
        result['integrity'] = db.execute('PRAGMA integrity_check').fetchone()[0]
        result['schemaVersion'] = db.execute('PRAGMA user_version').fetchone()[0]
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        result['counts'] = {name: db.execute('SELECT count(*) FROM "' + name + '"').fetchone()[0]
                            for name in ['workers', 'models', 'tickets', 'ticket_entries', 'production_adjustments', 'period_archives', 'local_outbox'] if name in tables}
        matches = []
        if 'production_adjustments' in tables:
            for row in db.execute('SELECT * FROM production_adjustments'):
                data = dict(row)
                if data.get('adjustment_id') not in expected_ids or data.get('company_id') != 'comp_novda':
                    continue
                fields = ['original_ticket_id', 'original_entry_id', 'original_period_id', 'original_rate_snapshot']
                matches.append({'adjustmentId': data['adjustment_id'], 'explicitOriginalFields': {f: data.get(f) for f in fields},
                                'completeExplicitAttribution': all(data.get(f) is not None for f in fields)})
        result['productionMatches'] = matches
        result['retainedCommandMatches'] = []
        if 'local_outbox' in tables:
            for row in db.execute('SELECT * FROM local_outbox'):
                data = dict(row)
                try:
                    payload = json.loads(data.get('payload_json', '{}'))
                except (ValueError, TypeError):
                    continue
                if payload.get('adjustmentId') in expected_ids and payload.get('companyId') == 'comp_novda':
                    fields = ['originalTicketId', 'originalEntryId', 'originalPeriodId', 'originalRateSnapshot']
                    result['retainedCommandMatches'].append({'adjustmentId': payload['adjustmentId'],
                        'payloadHash': data.get('payload_hash'), 'explicitOriginalFields': {f: payload.get(f) for f in fields},
                        'completeExplicitAttribution': all(payload.get(f) is not None for f in fields)})
        result['archives'] = []
        if 'period_archives' in tables:
            for row in db.execute('SELECT * FROM period_archives'):
                data = dict(row)
                result['archives'].append({k: data.get(k) for k in ['company_id', 'period_id', 'sha256']})
    finally:
        db.close()
    result['sourceUnchangedAfterInspection'] = all(p.is_file() and sha(p) == before[p.name] for p in related)
    return result


def main():
    output = pathlib.Path(sys.argv[1])
    business = pathlib.Path.home() / 'AppData/Roaming/novda-hisob-kitob/NovdaData'
    report = json.loads((ROOT / 'ops/docs/evidence/phase3-historical-reconciliation.json').read_text(encoding='utf-8'))
    ids = {r['adjustmentId'] for r in report['records']}
    scratch = pathlib.Path.home() / 'AppData/Local/Temp/opencode'
    files = sorted(p for p in business.rglob('*') if p.is_file() and (p.suffix == '.sqlite' or p.suffix == '.bak')) if business.exists() else []
    results = [inspect_sqlite(p, ids, scratch) for p in files]
    json_files = []
    for file in sorted(business.rglob('*.json')) if business.exists() else []:
        data = json.loads(file.read_text(encoding='utf-8-sig'))
        found = []

        def visit(value):
            if isinstance(value, dict):
                identity = value.get('adjustmentId', value.get('adjustment_id'))
                if identity in ids:
                    fields = ['originalTicketId', 'originalEntryId', 'originalPeriodId', 'originalRateSnapshot']
                    found.append({'adjustmentId': identity, 'explicitOriginalFields': {f: value.get(f) for f in fields},
                                  'completeExplicitAttribution': all(value.get(f) is not None for f in fields)})
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(data)
        json_files.append({'path': str(file), 'sha256': sha(file), 'matchingAdjustments': found})
    candidates = [r for result in results for r in result.get('productionMatches', []) + result.get('retainedCommandMatches', [])]
    candidates += [r for result in json_files for r in result['matchingAdjustments']]
    result = {'scope': str(business), 'sourceWrites': 0, 'credentialsRead': False,
              'sqliteFiles': results, 'jsonFiles': json_files,
              'originalBaselineHashMatches': sum(r['matchesOriginalBaseline'] for r in results),
              'completeDirectAttributionCandidates': [r for r in candidates if r['completeExplicitAttribution']],
              'policy': 'Discovery only. A candidate still requires tenant/fact/hash/immutable-work corroboration; classifications are NOT automatically promoted.'}
    with output.open('x', encoding='utf-8') as handle:
        json.dump(result, handle, indent=2, ensure_ascii=False)
        handle.write('\n')
    print(json.dumps({'sqliteFiles': len(results), 'jsonFiles': len(json_files), 'baselineMatches': result['originalBaselineHashMatches'],
                      'completeCandidates': len(result['completeDirectAttributionCandidates']), 'sourceWrites': 0}))


if __name__ == '__main__':
    main()
