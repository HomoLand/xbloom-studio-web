"""Private recipe catalog routes (no BLE required).

Legacy catalog may still use local paths internally; browser HTTP responses
and errors omit/redact them via the shared public output sanitizer.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query, UploadFile

from public_contract import redact_paths, sanitize_public_output
from xbloom_catalog import (
    CatalogError,
    catalog_summary,
    default_catalog_path,
    get_entry,
    import_payload,
    list_entries,
    load_catalog,
    save_catalog,
)
from xbloom_paths import skill_state_dir


router = APIRouter(prefix="/api/catalog", tags=["catalog"])


def _load() -> tuple[dict[str, Any], Any]:
    try:
        path = default_catalog_path(skill_state_dir())
        return load_catalog(path), path
    except CatalogError as exc:
        raise HTTPException(status_code=404, detail=redact_paths(str(exc))) from exc


@router.get("/status")
def status() -> dict[str, Any]:
    catalog, path = _load()
    # path still used internally for legacy catalog; stripped for HTTP.
    return sanitize_public_output({"path": str(path), **catalog_summary(catalog)})


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
    return sanitize_public_output(
        {"path": str(path), "count": len(entries), "entries": entries}
    )


@router.get("/show")
def show_item(id: str = Query(...)) -> dict[str, Any]:
    catalog, _ = _load()
    try:
        entry = get_entry(catalog, id)
    except CatalogError as exc:
        raise HTTPException(status_code=404, detail=redact_paths(str(exc))) from exc
    return sanitize_public_output({"entry": entry})


@router.post("/import")
async def import_recipes(file: UploadFile) -> dict[str, Any]:
    """Import recipes from an uploaded JSON file into the private catalog."""

    content = await file.read()
    try:
        payload = json.loads(content.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=400, detail=redact_paths(f"invalid JSON file: {exc}")
        ) from exc

    catalog, path = _load()
    try:
        result = import_payload(
            catalog,
            payload,
            source_type="web-upload",
            source_file=file.filename or "upload.json",
        )
        save_catalog(catalog, path)
    except CatalogError as exc:
        raise HTTPException(status_code=400, detail=redact_paths(str(exc))) from exc
    return sanitize_public_output({"path": str(path), **result})
