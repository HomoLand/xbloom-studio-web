"""Load and validate versioned knowledge bundles for design prompts.

Production requires an explicit ``XBLOOM_KNOWLEDGE_DIR`` with a valid
``manifest.json`` (``xbloom_knowledge.validate_bundle``). Development may set
``XBLOOM_KNOWLEDGE_DEV_ROOT`` explicitly; this module never walks sibling
checkouts silently.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from xbloom_knowledge import (
    KnowledgeError,
    build_manifest,
    validate_bundle,
    validate_manifest_data,
)

from design.errors import DesignUnavailableError

# Knowledge files required by the design service (B2).
REQUIRED_KNOWLEDGE_RELPATHS = (
    "SKILL.md",
    "references/recipe-design.md",
    "references/recipe-schema.md",
    "references/tea-brewing.md",
)


@dataclass(frozen=True)
class KnowledgeBundle:
    """Validated knowledge content used to build design prompts."""

    root: Path
    version: str
    content_hash: str
    skill_md: str
    recipe_design_md: str
    recipe_schema_md: str
    tea_brewing_md: str
    source: str  # "bundle" | "dev_root"

    def provenance(self) -> dict[str, str]:
        return {
            "knowledge_version": self.version,
            "knowledge_content_hash": self.content_hash,
            "knowledge_source": self.source,
        }


def _read_required(root: Path, rel: str) -> str:
    path = root / rel
    if not path.is_file():
        raise DesignUnavailableError(
            f"knowledge bundle missing required file: {rel}",
            code="knowledge_incomplete",
            details={"missing": rel},
        )
    return path.read_text(encoding="utf-8")


def _bundle_from_validated(
    root: Path,
    manifest: dict[str, Any],
    *,
    source: str,
) -> KnowledgeBundle:
    version = str(manifest.get("version") or "")
    content_hash = str(manifest.get("content_hash") or "")
    if not version or not content_hash:
        raise DesignUnavailableError(
            "knowledge manifest is missing version or content_hash",
            code="knowledge_invalid",
        )
    files = manifest.get("files")
    if not isinstance(files, dict):
        raise DesignUnavailableError(
            "knowledge manifest is missing files map",
            code="knowledge_invalid",
        )
    for rel in REQUIRED_KNOWLEDGE_RELPATHS:
        if rel not in files:
            raise DesignUnavailableError(
                f"knowledge manifest does not list required file: {rel}",
                code="knowledge_incomplete",
                details={"missing": rel},
            )
    return KnowledgeBundle(
        root=root,
        version=version,
        content_hash=content_hash,
        skill_md=_read_required(root, "SKILL.md"),
        recipe_design_md=_read_required(root, "references/recipe-design.md"),
        recipe_schema_md=_read_required(root, "references/recipe-schema.md"),
        tea_brewing_md=_read_required(root, "references/tea-brewing.md"),
        source=source,
    )


def load_knowledge_bundle(
    *,
    knowledge_dir: str | None,
    knowledge_dev_root: str | None,
) -> KnowledgeBundle:
    """Resolve and validate a knowledge bundle from explicit config only.

    Resolution order:
    1. ``knowledge_dir`` (``XBLOOM_KNOWLEDGE_DIR``) — production validated bundle.
    2. ``knowledge_dev_root`` (``XBLOOM_KNOWLEDGE_DEV_ROOT``) — explicit development
       override. If a ``manifest.json`` is present it is validated; otherwise a
       deterministic in-memory manifest is built and validated against on-disk files.

    Never discovers a sibling ``xbloom-studio-brew`` checkout.
    """

    if knowledge_dir:
        root = Path(knowledge_dir).expanduser().resolve()
        if not root.is_dir():
            # Do not embed the absolute path in the public error message.
            raise DesignUnavailableError(
                "XBLOOM_KNOWLEDGE_DIR is not a directory",
                code="knowledge_unavailable",
                details={"configured": True},
            )
        try:
            manifest = validate_bundle(root)
        except KnowledgeError as exc:
            raise DesignUnavailableError(
                "knowledge bundle validation failed",
                code="knowledge_invalid",
                details={"reason": "validation_failed"},
            ) from exc
        return _bundle_from_validated(root, manifest, source="bundle")

    if knowledge_dev_root:
        root = Path(knowledge_dev_root).expanduser().resolve()
        if not root.is_dir():
            raise DesignUnavailableError(
                "XBLOOM_KNOWLEDGE_DEV_ROOT is not a directory",
                code="knowledge_unavailable",
                details={"configured": True, "dev": True},
            )
        manifest_path = root / "manifest.json"
        try:
            if manifest_path.is_file():
                manifest = validate_bundle(root)
            else:
                # Explicit dev override only: build a deterministic manifest in memory.
                manifest = build_manifest(root, version="dev")
                validate_manifest_data(root, manifest)
        except KnowledgeError as exc:
            raise DesignUnavailableError(
                "development knowledge root validation failed",
                code="knowledge_invalid",
                details={"reason": "validation_failed", "dev": True},
            ) from exc
        return _bundle_from_validated(root, manifest, source="dev_root")

    raise DesignUnavailableError(
        "no valid knowledge bundle configured: set XBLOOM_KNOWLEDGE_DIR to a "
        "validated versioned knowledge bundle, or set XBLOOM_KNOWLEDGE_DEV_ROOT "
        "explicitly for development (sibling checkouts are never auto-discovered)",
        code="knowledge_unavailable",
        details={"configured": False},
    )
