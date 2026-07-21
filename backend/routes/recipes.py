"""Recipe template listing and validation routes."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from xbloom_safety import load_strict_recipe, recipe_summary


router = APIRouter(prefix="/api/recipes", tags=["recipes"])


def _assets_dir() -> Path | None:
    """Locate the Skill's bundled templates via env, decoupled from the repo layout."""

    configured = os.environ.get("XBLOOM_ASSETS_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return None


@router.get("/templates")
def list_templates() -> dict[str, Any]:
    """List bundled recipe templates (hot, flash-brew, and official tea)."""

    templates: list[dict[str, Any]] = []
    assets = _assets_dir()
    if assets and assets.is_dir():
        for path in sorted(assets.glob("*.yaml")):
            try:
                data = yaml.safe_load(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            is_tea = path.name.startswith("tea-")
            templates.append(
                {
                    "file": path.name,
                    "path": str(path),
                    "name": data.get("name", path.stem),
                    "kind": data.get("kind", "tea" if is_tea else "hot"),
                    "dose_g": data.get("dose_g") if not is_tea else None,
                    "leaf_g": data.get("leaf_g") if is_tea else None,
                    "water_ml": data.get("water_ml"),
                    "pours": len(data.get("pours", [])) if isinstance(data.get("pours"), list) else 0,
                    "tea": is_tea,
                }
            )
    return {
        "templates": templates,
        "assets_dir": str(assets) if assets else None,
        "hint": (
            None
            if assets
            else "set XBLOOM_ASSETS_DIR to the Skill's assets directory to list bundled templates"
        ),
    }


class ValidateBody(BaseModel):
    path: str | None = None


@router.post("/validate")
def validate_recipe(body: ValidateBody) -> dict[str, Any]:
    """Strictly validate a local recipe file. Never touches BLE."""

    if not body.path:
        raise HTTPException(status_code=400, detail="path is required")
    path = Path(body.path).expanduser()
    if not path.is_file():
        raise HTTPException(status_code=404, detail=f"recipe not found: {path}")
    try:
        recipe = load_strict_recipe(path)
        summary = recipe_summary(recipe, path)
    except Exception as exc:
        return {"valid": False, "error": str(exc), "type": type(exc).__name__}
    return {"valid": True, "summary": summary}
