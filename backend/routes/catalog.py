"""Private recipe catalog routes (no BLE required)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from xbloom_catalog import (
    CatalogError,
    catalog_summary,
    default_catalog_path,
    get_entry,
    list_entries,
    load_catalog,
)
from xbloom_paths import skill_state_dir


router = APIRouter(prefix="/api/catalog", tags=["catalog"])


def _load() -> dict[str, Any]:
    try:
        path = default_catalog_path(skill_state_dir())
        return load_catalog(path), path
    except CatalogError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/status")
def status() -> dict[str, Any]:
    catalog, path = _load()
    return {"path": str(path), **catalog_summary(catalog)}


@router.get("/list")
def list_items(
    kind: str | None = Query(None),
    executable_only: bool | None = Query(None),
    query: str | None = Query(None),
) -> dict[str, Any]:
    catalog, path = _load()
    kwargs: dict[str, Any] = {}
    if kind is not None:
        kwargs["kind"] = kind
    if executable_only is not None:
        kwargs["executable_only"] = executable_only
    if query is not None:
        kwargs["query"] = query
    entries = list_entries(catalog, **kwargs)
    return {"path": str(path), "count": len(entries), "entries": entries}


@router.get("/show")
def show_item(id: str = Query(...)) -> dict[str, Any]:
    catalog, _ = _load()
    try:
        entry = get_entry(catalog, id)
    except CatalogError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"entry": entry}
