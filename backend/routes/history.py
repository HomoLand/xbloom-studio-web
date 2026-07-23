"""Local brew journal routes (no BLE required).

Legacy history may still use local paths internally; browser HTTP responses
omit/redact them via the shared public output sanitizer.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query

from public_contract import sanitize_public_output
from xbloom_history import history_summary, list_events


router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("/status")
def status() -> dict[str, Any]:
    return sanitize_public_output(history_summary())


@router.get("/list")
def list_items(
    limit: int = Query(20, ge=1, le=200),
    source: str | None = Query(None),
    outcome: str | None = Query(None),
    query: str | None = Query(None),
) -> dict[str, Any]:
    events = list_events(limit=limit, source=source, outcome=outcome, query=query)
    return sanitize_public_output({"count": len(events), "events": events})
