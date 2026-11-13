#!/usr/bin/env python3
"""Independent exact-decimal STAJ allocation oracle for disposable fixtures."""
from decimal import Decimal
import json
import sys


def allocation(debt, earnings):
    debt, earnings = Decimal(debt), Decimal(earnings)
    if debt <= 0 or earnings < 0:
        raise ValueError("invalid amount")
    applied = min(debt, earnings)
    return {"allocation": format(applied, ".2f"), "deficit": format(debt - applied, ".2f"),
            "status": "SETTLED" if applied == debt else "REVIEW_REQUIRED"}


if __name__ == "__main__":
    print(json.dumps(allocation(sys.argv[1], sys.argv[2]), separators=(",", ":")))
