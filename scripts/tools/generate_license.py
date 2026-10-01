#!/usr/bin/env python3
"""Canonical activation payload helper retained for cross-runtime tests.

Production signing is restricted to the authorized novda-admin-bot service.
This standalone script intentionally cannot load or use production signer keys.
"""

import os
import sys

_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))
_serialization_dir = os.path.join(_root, 'packages', 'contracts', 'serialization')
if _serialization_dir not in sys.path:
    sys.path.insert(0, _serialization_dir)

from canonicalPayload import canonical_payload


def main():
    raise SystemExit('PRODUCTION_SIGNER_IS_ADMIN_BOT_ONLY')


if __name__ == '__main__':
    main()
