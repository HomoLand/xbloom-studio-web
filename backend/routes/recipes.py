"""Typed SQLite recipe CRUD and design-result save routes (Phase B9).

SQLite via ``xbloom_storage.StateStore`` is authoritative. Each handler opens
and closes its own store on the same worker thread (no module-global connection
and no generator dependency that may tear down on another thread).

Browser-facing surfaces never accept or return local file paths. Templates are
read only from the server-side ``XBLOOM_ASSETS_DIR`` and core-validated before
exposure.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Literal, Mapping

import yaml
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, model_validator

from design.validation import validate_design_document
from xbloom_storage import (
    StorageConflictError,
    StorageError,
    canonicalize_recipe_content,
    content_sha256,
    open_store,
    reject_forbidden_provenance,
)


# Absolute local paths only - never leak into HTTP error bodies.
_WIN_ABS_PATH_RE = re.compile(r"(?i)\b[a-z]:(?:\\+|/+)\S*")
_POSIX_ABS_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9_])/(?:home|Users|tmp|var|etc|root|opt|usr|private|"
    r"mnt|srv|data|run|Volumes|workspace|app)/[^\s\"'<>|]+"
)


class SafeValidationRoute(APIRoute):
    """Return validation details without echoing the rejected request input."""

    def get_route_handler(self):
        original_handler = super().get_route_handler()

        async def safe_handler(request: Request):
            try:
                return await original_handler(request)
            except RequestValidationError as exc:
                errors = [
                    {
                        "type": str(error.get("type") or "validation_error"),
                        "loc": [str(part) for part in error.get("loc", ())],
                        "message": _redact_paths(
                            str(error.get("msg") or "invalid request")
                        ),
                    }
                    for error in exc.errors()
                ]
                return JSONResponse(
                    status_code=422,
                    content={
                        "detail": {
                            "category": "validation",
                            "message": "request validation failed",
                            "errors": errors,
                        }
                    },
                )

        return safe_handler


router = APIRouter(
    prefix="/api/recipes",
    tags=["recipes"],
    route_class=SafeValidationRoute,
)

_SOURCE_WEB = "web"
_SOURCE_WEB_DESIGN = "web-design"
_CREATION_WEB = "web"
_CREATION_WEB_DESIGN = "web-design"

# ---------------------------------------------------------------------------
# Browser-unsafe request rejection (keys + absolute path string values)
# ---------------------------------------------------------------------------

_CAMEL_BOUNDARY_RE = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")
_BROWSER_ONLY_FORBIDDEN_TOKENS = frozenset({"command", "shell"})
_SHA256_HEX_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _browser_only_forbidden_key(key: str) -> bool:
    """Reject command-bearing fields not covered by core provenance policy."""

    tokens: list[str] = []
    for chunk in re.split(r"[^A-Za-z0-9]+", str(key)):
        tokens.extend(piece.lower() for piece in _CAMEL_BOUNDARY_RE.findall(chunk))
    return any(token in _BROWSER_ONLY_FORBIDDEN_TOKENS for token in tokens)


def _contains_absolute_local_path(value: str) -> bool:
    """True when a string value embeds a Windows or POSIX absolute local path."""

    if value.strip().casefold().startswith("file://"):
        return True
    if _WIN_ABS_PATH_RE.search(value):
        return True
    if _POSIX_ABS_PATH_RE.search(value):
        return True
    return False


def reject_browser_unsafe_payload(value: Any, *, path: str = "$") -> None:
    """Recursively reject forbidden keys and absolute local path string values.

    Raises ``ValueError`` (FastAPI -> 422) so unsafe data never reaches storage.
    """

    try:
        reject_forbidden_provenance(value, path=path)
    except StorageError as exc:
        raise ValueError(str(exc)) from exc

    def walk(current: Any, current_path: str) -> None:
        if isinstance(current, Mapping):
            for key, child in current.items():
                key_s = str(key)
                child_path = f"{current_path}.{key_s}"
                if _browser_only_forbidden_key(key_s):
                    raise ValueError(f"forbidden field {key_s!r} at {child_path}")
                walk(child, child_path)
            return
        if isinstance(current, (list, tuple)):
            for index, child in enumerate(current):
                walk(child, f"{current_path}[{index}]")
            return
        if isinstance(current, str) and _contains_absolute_local_path(current):
            raise ValueError(
                f"absolute local path values are not allowed at {current_path}"
            )

    walk(value, path)


# ---------------------------------------------------------------------------
# StateStore lifecycle (same-thread open/close)
# ---------------------------------------------------------------------------


@contextmanager
def state_store() -> Iterator[Any]:
    """Open a StateStore for one request and always close it on the same thread."""

    store = open_store()
    try:
        yield store
    finally:
        store.close()


# ---------------------------------------------------------------------------
# Request models (extra fields forbidden + browser-unsafe rejection)
# ---------------------------------------------------------------------------


class StrictRequestModel(BaseModel):
    """Base for every B9 request body: forbid extras and unsafe browser data."""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _reject_browser_unsafe(cls, data: Any) -> Any:
        if data is not None:
            reject_browser_unsafe_payload(data)
        return data


class ValidateBody(StrictRequestModel):
    """Validate in-memory recipe content only (no path)."""

    content: dict[str, Any]


class CreateRecipeBody(StrictRequestModel):
    content: dict[str, Any]
    name: str | None = None
    tags: list[str] | None = None
    provenance: dict[str, Any] | None = None


class CreateRevisionBody(StrictRequestModel):
    content: dict[str, Any]
    expected_parent_revision_id: str = Field(min_length=1)
    name: str | None = None
    tags: list[str] | None = None
    provenance: dict[str, Any] | None = None


class ArchiveRestoreBody(StrictRequestModel):
    expected_latest_revision_id: str = Field(min_length=1)


class DesignProvenanceBody(StrictRequestModel):
    """Typed B7 design provenance. No image bytes, paths, secrets, or reasoning.

    Matches design service public provenance: ``knowledge_source`` is
    ``bundle`` or ``dev_root``, ``used_image`` is a boolean fact, and
    ``candidate_hash`` is a SHA-256 hex digest.
    """

    provider: str = Field(min_length=1, max_length=120)
    model: str = Field(min_length=1, max_length=120)
    knowledge_version: str = Field(min_length=1, max_length=80)
    knowledge_content_hash: str = Field(min_length=1, max_length=128)
    prompt_template_version: str = Field(min_length=1, max_length=80)
    schema_version: str = Field(min_length=1, max_length=80)
    candidate_hash: str = Field(min_length=64, max_length=64)
    knowledge_source: Literal["bundle", "dev_root"]
    design_mode: str | None = Field(default=None, min_length=1, max_length=40)
    repaired: bool | None = None
    used_image: bool
    used_ocr: bool | None = None

    @model_validator(mode="after")
    def _candidate_hash_sha256_hex(self) -> DesignProvenanceBody:
        if not _SHA256_HEX_RE.fullmatch(self.candidate_hash):
            raise ValueError("candidate_hash must be a SHA-256 hex string")
        return self


class DesignEvidenceItem(StrictRequestModel):
    source: str = Field(min_length=1, max_length=40)
    claim: str = Field(min_length=1, max_length=400)
    value: str | None = Field(default=None, max_length=200)


class FromDesignBody(StrictRequestModel):
    """Save a design-service result as a new recipe + revision."""

    recipe_candidate: dict[str, Any]
    design_rationale: str = Field(min_length=1, max_length=2000)
    evidence: list[DesignEvidenceItem]
    provenance: DesignProvenanceBody
    name: str | None = Field(default=None, min_length=1, max_length=120)
    tags: list[str] | None = None


# ---------------------------------------------------------------------------
# Error mapping / path hygiene
# ---------------------------------------------------------------------------


def _redact_paths(message: str) -> str:
    out = _WIN_ABS_PATH_RE.sub("[redacted-path]", message)
    out = _POSIX_ABS_PATH_RE.sub("[redacted-path]", out)
    return out


def _error_detail(category: str, message: str) -> dict[str, Any]:
    """Device-style detail: ``detail.category`` / ``detail.message`` (not nested)."""

    return {
        "category": category,
        "message": _redact_paths(message),
    }


def _raise_http(status: int, category: str, message: str) -> None:
    raise HTTPException(status_code=status, detail=_error_detail(category, message))


def _map_storage_error(exc: StorageError) -> None:
    """Map StorageError / StorageConflictError to stable HTTP categories."""

    if isinstance(exc, StorageConflictError):
        _raise_http(409, "conflict", str(exc))
    msg = str(exc)
    lower = msg.lower()
    if "unknown recipe" in lower:
        _raise_http(404, "not_found", msg)
    # Validation / domain / forbidden provenance / bad args.
    _raise_http(400, "validation", msg)


def _metadata_from_tags(tags: list[str] | None) -> dict[str, Any] | None:
    """Tags are the only browser-supplied metadata."""

    if tags is None:
        return None
    return {"tags": list(tags)}


def _design_style_hash(candidate: dict[str, Any]) -> str:
    payload = json.dumps(
        candidate,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _content_summary(canonical: dict[str, Any], storage_kind: str) -> dict[str, Any]:
    """Compact summary fields for templates / list helpers (no paths)."""

    pours = canonical.get("pours")
    pour_count = len(pours) if isinstance(pours, list) else 0
    domain_kind = str(canonical.get("kind") or storage_kind)
    summary: dict[str, Any] = {
        "name": canonical.get("name"),
        "kind": domain_kind,
        "pours": pour_count,
    }
    if storage_kind == "tea" or domain_kind == "tea":
        summary["leaf_g"] = canonical.get("leaf_g")
        summary["output_ml_per_steep"] = canonical.get("output_ml_per_steep")
    else:
        summary["dose_g"] = canonical.get("dose_g")
        summary["grind"] = canonical.get("grind")
        summary["water_ml"] = canonical.get("water_ml")
        if canonical.get("hot_water_ml") is not None:
            summary["hot_water_ml"] = canonical.get("hot_water_ml")
        if canonical.get("ice_g") is not None:
            summary["ice_g"] = canonical.get("ice_g")
    return summary


def _assets_dir() -> Path | None:
    configured = os.environ.get("XBLOOM_ASSETS_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return None


# ---------------------------------------------------------------------------
# Fixed routes (declared before dynamic {recipe_id})
# ---------------------------------------------------------------------------


@router.get("/templates")
def list_templates() -> dict[str, Any]:
    """List bundled recipe templates from server-side assets only.

    Returns ``template_id``, ``name``, ``kind``, summary fields, and canonical
    ``content``. Never returns file, path, assets_dir, or absolute paths.
    """

    templates: list[dict[str, Any]] = []
    assets = _assets_dir()
    if assets is None or not assets.is_dir():
        return {"templates": templates}

    for path in sorted(assets.glob("*.yaml")):
        try:
            raw = path.read_text(encoding="utf-8")
            data = yaml.safe_load(raw)
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        try:
            canonical, storage_kind = canonicalize_recipe_content(data)
        except StorageError:
            # Skip non-recipe assets (e.g. bean-input.yaml).
            continue
        summary = _content_summary(canonical, storage_kind)
        domain_kind = str(canonical.get("kind") or summary["kind"])
        templates.append(
            {
                "template_id": path.stem,
                "name": str(canonical.get("name") or path.stem),
                "kind": domain_kind,
                **{
                    k: v
                    for k, v in summary.items()
                    if k not in {"name", "kind"}
                },
                "content": canonical,
            }
        )
    return {"templates": templates}


@router.post("/validate")
def validate_recipe(body: ValidateBody) -> dict[str, Any]:
    """Core-validate recipe content object. Path-based bodies are rejected."""

    try:
        canonical, storage_kind = canonicalize_recipe_content(body.content)
    except StorageError as exc:
        return {
            "valid": False,
            "error": {
                "category": "validation",
                "message": _redact_paths(str(exc)),
                "type": type(exc).__name__,
            },
        }
    domain_kind = str(canonical.get("kind") or storage_kind)
    return {
        "valid": True,
        "kind": domain_kind,
        "storage_kind": storage_kind,
        "content": canonical,
    }


@router.post("/from-design")
def create_from_design(body: FromDesignBody) -> dict[str, Any]:
    """Atomically create a recipe from a design-service result.

    Rebuilds the B5/B6 design document, runs ``validate_design_document``, and
    persists only the validated canonical candidate / rationale / evidence.
    Preserves provider ``candidate_hash``, records ``saved_candidate_hash`` and
    ``candidate_modified``. Source and creation_source are ``web-design``.
    Original image bytes and local paths are impossible (forbidden by model +
    browser-unsafe guard + core sanitizer).
    """

    evidence_payload = [item.model_dump(exclude_none=True) for item in body.evidence]
    design_document = {
        "recipe_candidate": body.recipe_candidate,
        "design_rationale": body.design_rationale,
        "evidence": evidence_payload,
    }
    validation = validate_design_document(
        json.dumps(
            design_document,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        design_document,
    )
    if not validation.valid:
        msg = "; ".join(validation.error_messages()) or "design document invalid"
        _raise_http(400, "validation", msg)

    validated_candidate = validation.recipe_candidate
    if not isinstance(validated_candidate, dict):
        _raise_http(400, "validation", "design document produced no recipe candidate")

    # Build safe provenance: required B7 fields + optional flags + design text.
    prov: dict[str, Any] = {
        "provider": body.provenance.provider,
        "model": body.provenance.model,
        "knowledge_version": body.provenance.knowledge_version,
        "knowledge_content_hash": body.provenance.knowledge_content_hash,
        "knowledge_source": body.provenance.knowledge_source,
        "prompt_template_version": body.provenance.prompt_template_version,
        "schema_version": body.provenance.schema_version,
        # Preserve provider hash even when the user edited the candidate.
        "candidate_hash": body.provenance.candidate_hash,
        "used_image": body.provenance.used_image,
    }
    if body.provenance.design_mode is not None:
        prov["design_mode"] = body.provenance.design_mode
    if body.provenance.repaired is not None:
        prov["repaired"] = body.provenance.repaired
    if body.provenance.used_ocr is not None:
        prov["used_ocr"] = body.provenance.used_ocr

    prov["design_rationale"] = validation.design_rationale
    prov["evidence"] = list(validation.evidence)

    validated_design_hash = validation.candidate_hash or _design_style_hash(
        validated_candidate
    )
    try:
        canonical, _storage_kind = canonicalize_recipe_content(validated_candidate)
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover - _map_storage_error always raises

    saved_hash = content_sha256(canonical)
    candidate_modified = validated_design_hash != body.provenance.candidate_hash
    prov["saved_candidate_hash"] = saved_hash
    prov["candidate_modified"] = candidate_modified

    metadata = _metadata_from_tags(body.tags)
    try:
        with state_store() as store:
            result = store.create_recipe_with_revision(
                validated_candidate,
                name=body.name,
                source=_SOURCE_WEB_DESIGN,
                provenance=prov,
                metadata=metadata,
                creation_source=_CREATION_WEB_DESIGN,
            )
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover

    return result


@router.get("")
@router.get("/")
def list_recipes(
    kind: Literal["coffee", "tea"] | None = Query(None),
    query: str | None = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    include_archived: bool = Query(False),
) -> dict[str, Any]:
    """List recipes from StateStore (authoritative SQLite)."""

    try:
        with state_store() as store:
            recipes = store.list_recipes(
                kind=kind,
                query=query,
                limit=limit,
                offset=offset,
                include_archived=include_archived,
            )
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover
    return {"count": len(recipes), "recipes": recipes}


@router.post("")
@router.post("/")
def create_recipe(body: CreateRecipeBody) -> dict[str, Any]:
    """Atomically create a recipe plus its first immutable revision."""

    metadata = _metadata_from_tags(body.tags)
    try:
        with state_store() as store:
            result = store.create_recipe_with_revision(
                body.content,
                name=body.name,
                source=_SOURCE_WEB,
                provenance=body.provenance,
                metadata=metadata,
                creation_source=_CREATION_WEB,
            )
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover
    return result


# ---------------------------------------------------------------------------
# Dynamic recipe_id routes (after fixed paths)
# ---------------------------------------------------------------------------


@router.get("/{recipe_id}")
def get_recipe(recipe_id: str) -> dict[str, Any]:
    """Return one recipe plus its latest_revision; 404 if unknown."""

    try:
        with state_store() as store:
            recipe = store.get_recipe(recipe_id)
            if recipe is None:
                _raise_http(404, "not_found", f"unknown recipe_id {recipe_id!r}")
            latest = store.get_latest_recipe_revision(recipe_id)
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover
    return {"recipe": recipe, "latest_revision": latest}


@router.get("/{recipe_id}/revisions")
def list_revisions(recipe_id: str) -> dict[str, Any]:
    """Stable revision history; 404 if recipe unknown."""

    try:
        with state_store() as store:
            recipe = store.get_recipe(recipe_id)
            if recipe is None:
                _raise_http(404, "not_found", f"unknown recipe_id {recipe_id!r}")
            revisions = store.list_recipe_revisions(recipe_id)
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover
    return {"recipe_id": recipe_id, "count": len(revisions), "revisions": revisions}


@router.post("/{recipe_id}/revisions")
def create_revision(recipe_id: str, body: CreateRevisionBody) -> dict[str, Any]:
    """Create a new revision with mandatory expected-parent OCC (409 on stale)."""

    metadata = _metadata_from_tags(body.tags)
    try:
        with state_store() as store:
            result = store.create_recipe_revision(
                recipe_id,
                body.content,
                expected_parent_revision_id=body.expected_parent_revision_id,
                name=body.name,
                source=_SOURCE_WEB,
                provenance=body.provenance,
                metadata=metadata,
                creation_source=_CREATION_WEB,
            )
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover
    return result


@router.post("/{recipe_id}/archive")
def archive_recipe(recipe_id: str, body: ArchiveRestoreBody) -> dict[str, Any]:
    """Soft-archive with mandatory latest-revision guard."""

    try:
        with state_store() as store:
            recipe = store.archive_recipe(
                recipe_id,
                expected_latest_revision_id=body.expected_latest_revision_id,
            )
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover
    return {"recipe": recipe}


@router.post("/{recipe_id}/restore")
def restore_recipe(recipe_id: str, body: ArchiveRestoreBody) -> dict[str, Any]:
    """Restore a previously archived recipe with mandatory latest-revision guard."""

    try:
        with state_store() as store:
            recipe = store.restore_recipe(
                recipe_id,
                expected_latest_revision_id=body.expected_latest_revision_id,
            )
    except StorageError as exc:
        _map_storage_error(exc)
        raise  # pragma: no cover
    return {"recipe": recipe}
