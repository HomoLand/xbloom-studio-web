"""Schema + core validation for design recipe candidates.

Provider output is never sent to BLE or storage here. At most one constrained
repair is orchestrated by the service layer after field-level errors are collected.

Unit normalization runs **before** strict schema so values like ``\"15g\"`` become
numbers the schema accepts. Public candidates/evidence are allowlisted so
illegal or privileged fields never enter the editable recipe_candidate (B5).
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError as JsonSchemaValidationError

from xbloom_ble.recipe import Recipe, RecipeError
from xbloom_ble.tea import TeaRecipe, TeaRecipeError
from xbloom_safety import SafetyError, strict_validate

from design.schema import get_design_output_schema
from design.units import normalize_recipe_candidate

# Allowlisted editable fields (coffee / tea) including nested pours — B5.
_COFFEE_TOP_KEYS = frozenset(
    {
        "name",
        "kind",
        "dripper",
        "dose_g",
        "grind",
        "ratio",
        "water_ml",
        "hot_water_ml",
        "bypass_ml",
        "bypass_temp_c",
        "ice_g",
        "time",
        "note",
        "pours",
    }
)
_COFFEE_POUR_KEYS = frozenset(
    {"label", "ml", "temp_c", "pattern", "vibration", "pause_s", "rpm", "flow_ml_s"}
)
_TEA_TOP_KEYS = frozenset({"name", "kind", "leaf_g", "output_ml_per_steep", "pours"})
_TEA_POUR_KEYS = frozenset({"label", "ml", "temp_c", "pattern", "pause_s", "flow_ml_s"})
_EVIDENCE_KEYS = frozenset({"source", "claim", "value"})
_EVIDENCE_SOURCES = frozenset(
    {"user_text", "bag_label", "official_recipe", "ocr", "inference", "knowledge"}
)
# Keys that must never appear even if they look "almost" like recipe fields.
_PRIVILEGED_DROP_KEYS = frozenset(
    {
        "api_key",
        "authorization",
        "XBLOOM_LLM_API_KEY",
        "raw_image",
        "image_base64",
        "image_bytes",
        "chain_of_thought",
        "reasoning",
        "thinking",
        "local_path",
        "file_path",
        "image_path",
        "path",
        "command",
        "shell",
        "secret",
        "secrets",
        "token",
        "password",
    }
)


@dataclass
class FieldError:
    path: str
    message: str
    stage: str  # parse | schema | core

    def to_dict(self) -> dict[str, str]:
        return {"path": self.path, "message": self.message, "stage": self.stage}


@dataclass
class ValidationResult:
    valid: bool
    recipe_candidate: dict[str, Any] | None
    design_rationale: str | None
    evidence: list[dict[str, Any]]
    errors: list[FieldError] = field(default_factory=list)
    candidate_hash: str | None = None
    beverage: str | None = None  # coffee | tea

    def error_messages(self) -> list[str]:
        return [f"{e.path}: {e.message}" if e.path else e.message for e in self.errors]

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "errors": [e.to_dict() for e in self.errors],
            "beverage": self.beverage,
            "candidate_hash": self.candidate_hash,
        }


def candidate_content_hash(candidate: dict[str, Any] | None) -> str | None:
    if candidate is None:
        return None
    payload = json.dumps(candidate, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _schema_path(error: JsonSchemaValidationError) -> str:
    parts = [str(p) for p in error.absolute_path]
    return ".".join(parts) if parts else "$"


def parse_provider_output(
    raw_text: str, parsed: dict[str, Any] | None
) -> tuple[dict[str, Any] | None, list[FieldError]]:
    """Parse provider text into a dict; return field errors on failure."""

    if parsed is not None:
        if not isinstance(parsed, dict):
            return None, [FieldError("$", "provider output is not a JSON object", "parse")]
        return parsed, []
    text = (raw_text or "").strip()
    if not text:
        return None, [FieldError("$", "provider returned empty content", "parse")]
    if text.startswith("```"):
        lines = text.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, [
            FieldError(
                "$",
                f"provider output is not valid JSON: {exc.msg}",
                "parse",
            )
        ]
    if not isinstance(data, dict):
        return None, [FieldError("$", "provider JSON root must be an object", "parse")]
    return data, []


def validate_against_schema(document: dict[str, Any]) -> list[FieldError]:
    schema = get_design_output_schema()
    validator = Draft202012Validator(schema)
    errors: list[FieldError] = []
    for error in sorted(validator.iter_errors(document), key=lambda e: list(e.absolute_path)):
        errors.append(
            FieldError(
                path=_schema_path(error),
                message=error.message,
                stage="schema",
            )
        )
    return errors


def allowlist_recipe_candidate(candidate: dict[str, Any] | None) -> dict[str, Any] | None:
    """Return only coffee/tea schema fields (including nested pours).

    Drops path/command/secret/reasoning/unknown keys so they never enter the
    editable candidate returned to clients (B5).
    """

    if not isinstance(candidate, dict):
        return None

    kind = str(candidate.get("kind", "")).strip().lower()
    if kind == "tea":
        top_keys = _TEA_TOP_KEYS
        pour_keys = _TEA_POUR_KEYS
    else:
        # coffee / flash-brew / incomplete candidates: coffee allowlist
        top_keys = _COFFEE_TOP_KEYS
        pour_keys = _COFFEE_POUR_KEYS

    out: dict[str, Any] = {}
    for key, value in candidate.items():
        if key in _PRIVILEGED_DROP_KEYS:
            continue
        if key not in top_keys:
            continue
        if key == "pours" and isinstance(value, list):
            pours: list[Any] = []
            for pour in value:
                if not isinstance(pour, dict):
                    continue
                clean_pour: dict[str, Any] = {}
                for pk, pv in pour.items():
                    if pk in _PRIVILEGED_DROP_KEYS:
                        continue
                    if pk in pour_keys:
                        clean_pour[pk] = pv
                pours.append(clean_pour)
            out["pours"] = pours
        else:
            out[key] = value
    return out


def allowlist_evidence(evidence: Any) -> list[dict[str, Any]]:
    """Keep only allowlisted evidence item fields; drop privileged/unknown keys."""

    if not isinstance(evidence, list):
        return []
    out: list[dict[str, Any]] = []
    for item in evidence:
        if not isinstance(item, dict):
            continue
        clean: dict[str, Any] = {}
        for key, value in item.items():
            if key in _PRIVILEGED_DROP_KEYS:
                continue
            if key not in _EVIDENCE_KEYS:
                continue
            clean[key] = value
        if not clean:
            continue
        # Soft-filter unknown sources so junk strings do not expand the surface.
        source = clean.get("source")
        if source is not None and source not in _EVIDENCE_SOURCES:
            clean.pop("source", None)
        if "claim" not in clean and "value" not in clean and "source" not in clean:
            continue
        out.append(clean)
    return out


def _tea_candidate_dict(recipe: TeaRecipe, original: dict[str, Any]) -> dict[str, Any]:
    """Rebuild a serializable tea candidate after core acceptance.

    Core ``TOP_LEVEL_KEYS`` has no ``note``; do not reintroduce it.
    """

    pours: list[dict[str, Any]] = []
    for index, pour in enumerate(recipe.pours):
        item: dict[str, Any] = {
            "ml": int(pour.ml),
            "temp_c": int(pour.temp_c),
            "pattern": pour.pattern,
            "pause_s": int(pour.pause_s),
            "flow_ml_s": float(pour.flow_ml_s),
        }
        if pour.label:
            item["label"] = pour.label
        elif isinstance(original.get("pours"), list) and index < len(original["pours"]):
            raw = original["pours"][index]
            if isinstance(raw, dict) and raw.get("label"):
                item["label"] = str(raw["label"])
        pours.append(item)
    return {
        "name": recipe.name or str(original.get("name") or "Tea"),
        "kind": "tea",
        "leaf_g": float(recipe.leaf_g),
        "output_ml_per_steep": int(recipe.output_ml_per_steep),
        "pours": pours,
    }


def validate_core_recipe(
    candidate: dict[str, Any],
) -> tuple[dict[str, Any] | None, str | None, list[FieldError]]:
    """Validate with core objects; return normalized candidate, beverage, errors."""

    kind = str(candidate.get("kind", "")).strip().lower()
    errors: list[FieldError] = []

    if kind == "tea":
        try:
            tea = TeaRecipe.from_dict(candidate)
            tea.validate()
        except (TeaRecipeError, ValueError, TypeError, KeyError) as exc:
            errors.append(FieldError("recipe_candidate", str(exc), "core"))
            return None, "tea", errors
        return _tea_candidate_dict(tea, candidate), "tea", []

    # Coffee / flash-brew path
    try:
        normalized = normalize_recipe_candidate(candidate)
        recipe = Recipe.from_dict(normalized)
        strict_validate(recipe)
        normalized_out = recipe.to_dict()
    except (RecipeError, SafetyError, ValueError, TypeError, KeyError) as exc:
        errors.append(FieldError("recipe_candidate", str(exc), "core"))
        return None, "coffee", errors
    return normalized_out, "coffee", []


def validate_design_document(
    raw_text: str,
    parsed: dict[str, Any] | None = None,
) -> ValidationResult:
    """Full parse → unit-normalize → schema → core validation pipeline."""

    document, parse_errors = parse_provider_output(raw_text, parsed)
    if parse_errors or document is None:
        return ValidationResult(
            valid=False,
            recipe_candidate=None,
            design_rationale=None,
            evidence=[],
            errors=parse_errors,
        )

    # Normalize the candidate first, place into a copied document, then schema.
    work = deepcopy(document)
    raw_candidate = work.get("recipe_candidate")
    if isinstance(raw_candidate, dict):
        try:
            work["recipe_candidate"] = normalize_recipe_candidate(raw_candidate)
        except TypeError as exc:
            return ValidationResult(
                valid=False,
                recipe_candidate=allowlist_recipe_candidate(raw_candidate),
                design_rationale=(
                    str(work["design_rationale"])
                    if isinstance(work.get("design_rationale"), str)
                    else None
                ),
                evidence=allowlist_evidence(work.get("evidence")),
                errors=[FieldError("recipe_candidate", str(exc), "parse")],
                candidate_hash=candidate_content_hash(
                    allowlist_recipe_candidate(raw_candidate)
                ),
            )

    schema_errors = validate_against_schema(work)
    if schema_errors:
        partial = work.get("recipe_candidate")
        partial_dict = allowlist_recipe_candidate(partial if isinstance(partial, dict) else None)
        rationale = work.get("design_rationale")
        evidence = allowlist_evidence(work.get("evidence"))
        return ValidationResult(
            valid=False,
            recipe_candidate=partial_dict,
            design_rationale=str(rationale) if isinstance(rationale, str) else None,
            evidence=evidence,
            errors=schema_errors,
            candidate_hash=candidate_content_hash(partial_dict),
        )

    rationale = str(work["design_rationale"])
    evidence = allowlist_evidence(work.get("evidence"))
    normalized_candidate = work["recipe_candidate"]
    if not isinstance(normalized_candidate, dict):
        return ValidationResult(
            valid=False,
            recipe_candidate=None,
            design_rationale=rationale,
            evidence=evidence,
            errors=[FieldError("recipe_candidate", "must be an object", "schema")],
        )

    core_candidate, beverage, core_errors = validate_core_recipe(normalized_candidate)
    if core_errors:
        public_candidate = allowlist_recipe_candidate(normalized_candidate)
        return ValidationResult(
            valid=False,
            recipe_candidate=public_candidate,
            design_rationale=rationale,
            evidence=evidence,
            errors=core_errors,
            candidate_hash=candidate_content_hash(public_candidate),
            beverage=beverage,
        )

    assert core_candidate is not None
    public_core = allowlist_recipe_candidate(core_candidate)
    return ValidationResult(
        valid=True,
        recipe_candidate=public_core,
        design_rationale=rationale,
        evidence=evidence,
        errors=[],
        candidate_hash=candidate_content_hash(public_core),
        beverage=beverage,
    )
