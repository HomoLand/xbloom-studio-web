"""Versioned strict JSON Schema for design provider structured output.

``additionalProperties: false`` throughout. Schema version is part of provenance.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

SCHEMA_VERSION = "recipe-design-output-v1"

# Shared pour patterns for coffee and tea (ring accepted as legacy alias at core).
_COFFEE_POUR = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ml", "temp_c", "pattern", "pause_s", "rpm", "flow_ml_s"],
    "properties": {
        "label": {"type": "string", "maxLength": 80},
        "ml": {"type": "number", "minimum": 10, "maximum": 127},
        "temp_c": {
            "oneOf": [
                {"type": "string", "enum": ["RT", "BP"]},
                {"type": "number", "minimum": 40, "maximum": 95},
            ]
        },
        "pattern": {
            "type": "string",
            "enum": ["spiral", "circular", "center", "ring"],
        },
        "vibration": {
            "type": "string",
            "enum": ["none", "before", "after", "both"],
        },
        "pause_s": {"type": "number", "minimum": 0, "maximum": 60},
        "rpm": {"type": "number", "minimum": 0, "maximum": 120},
        "flow_ml_s": {"type": "number", "minimum": 3.0, "maximum": 3.5},
    },
}

_TEA_POUR = {
    "type": "object",
    "additionalProperties": False,
    "required": ["ml", "temp_c", "pattern", "pause_s", "flow_ml_s"],
    "properties": {
        "label": {"type": "string", "maxLength": 80},
        "ml": {"type": "number", "minimum": 40, "maximum": 100},
        "temp_c": {"type": "number", "minimum": 70, "maximum": 99},
        "pattern": {
            "type": "string",
            "enum": ["spiral", "circular", "center", "ring"],
        },
        "pause_s": {"type": "number", "minimum": 1, "maximum": 120},
        "flow_ml_s": {"type": "number", "minimum": 3.0, "maximum": 3.5},
    },
}

_COFFEE_RECIPE = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "name",
        "kind",
        "dose_g",
        "grind",
        "ratio",
        "water_ml",
        "pours",
    ],
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 120},
        "kind": {"type": "string", "enum": ["hot", "flash-brew"]},
        "dripper": {"type": "string", "maxLength": 80},
        "dose_g": {"type": "number", "minimum": 5, "maximum": 18},
        "grind": {"type": "number", "minimum": 0, "maximum": 75},
        "ratio": {"type": "number", "minimum": 8, "maximum": 20},
        "water_ml": {"type": "number", "minimum": 60, "maximum": 540},
        "hot_water_ml": {"type": "number", "minimum": 60, "maximum": 360},
        "bypass_ml": {"type": "number", "minimum": 0, "maximum": 100},
        "bypass_temp_c": {
            "oneOf": [
                {"type": "string", "enum": ["RT", "BP"]},
                {"type": "number", "minimum": 40, "maximum": 95},
            ]
        },
        "ice_g": {"type": "number", "minimum": 40, "maximum": 180},
        "time": {"type": "string", "maxLength": 40},
        "note": {"type": "string", "maxLength": 500},
        "pours": {
            "type": "array",
            "minItems": 2,
            "maxItems": 5,
            "items": _COFFEE_POUR,
        },
    },
}

_TEA_RECIPE = {
    "type": "object",
    "additionalProperties": False,
    "required": ["name", "kind", "leaf_g", "output_ml_per_steep", "pours"],
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 120},
        "kind": {"type": "string", "enum": ["tea"]},
        "leaf_g": {"type": "number", "minimum": 3, "maximum": 5},
        # Must match core TeaRecipe.validate: 80-160 ml finished-cup display value.
        "output_ml_per_steep": {"type": "number", "minimum": 80, "maximum": 160},
        # Core TOP_LEVEL_KEYS has no "note"; do not accept it in schema.
        "pours": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "items": _TEA_POUR,
        },
    },
}

_EVIDENCE_ITEM = {
    "type": "object",
    "additionalProperties": False,
    "required": ["source", "claim"],
    "properties": {
        "source": {
            "type": "string",
            "enum": [
                "user_text",
                "bag_label",
                "official_recipe",
                "ocr",
                "inference",
                "knowledge",
            ],
        },
        "claim": {"type": "string", "minLength": 1, "maxLength": 400},
        "value": {"type": "string", "maxLength": 200},
    },
}

DESIGN_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": f"https://xbloom.local/schemas/{SCHEMA_VERSION}.json",
    "title": "xBloom design provider output",
    "type": "object",
    "additionalProperties": False,
    "required": ["recipe_candidate", "design_rationale", "evidence"],
    "properties": {
        "recipe_candidate": {
            "oneOf": [
                _COFFEE_RECIPE,
                _TEA_RECIPE,
            ]
        },
        "design_rationale": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000,
            "description": "Concise design rationale only; no chain-of-thought.",
        },
        "evidence": {
            "type": "array",
            "maxItems": 20,
            "items": _EVIDENCE_ITEM,
        },
    },
}


def get_design_output_schema() -> dict[str, Any]:
    """Return a deep copy of the versioned design output schema."""

    return deepcopy(DESIGN_OUTPUT_SCHEMA)


def schema_version() -> str:
    return SCHEMA_VERSION
