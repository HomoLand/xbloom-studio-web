"""Local brew journal routes (no BLE required)."""

from __future__ import annotations

from fastapi import APIRouter, Query

from xbloom_history import history_summary, list_events


router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("/status")
def status() -> dict[str, Any]:
    return history_summary()


@router.get("/list")
def list_items(
    limit: int = Query(20, ge=1, le=200),
    source: str | None = Query(None),
    outcome: str | None = Query(None),
    query: str | None = Query(None),
) -> dict[str, Any]:
    events = list_events(limit=limit, source=source, outcome=outcome, query=query)
    return {"count": len(events), "events": events}
