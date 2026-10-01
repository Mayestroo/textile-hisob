"""Canonical Ed25519 activation payload serialization used by Electron clients."""

import json


ACTIVATION_FIELDS = (
    'activationId',
    'companyId',
    'companyName',
    'expiresAt',
    'issuedAt',
    'machineId',
    'requireTicketValidation',
    'role',
    'schema',
    'status',
)


def canonical_activation_payload(payload: dict) -> bytes:
    if not isinstance(payload, dict):
        raise TypeError('Activation payload must be an object.')
    ordered_payload = {field: payload[field] for field in ACTIVATION_FIELDS}
    return json.dumps(ordered_payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
