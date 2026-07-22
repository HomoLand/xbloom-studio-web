"""Deterministic unit normalization for recipe candidates.

Applied before core object construction. Does not invent missing required fields.
"""

from __future__ import annotations

import re
from typing import Any

_NUMBER_RE = re.compile(
    r"^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*"
    r"(g|gram|grams|ml|milliliter|milliliters|mL|c|C|°c|°C|celsius|s|sec|secs|second|seconds|rpm)?\s*$",
    re.IGNORECASE,
)


def _to_number(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if not isinstance(value, str):
        return value
    text = value.strip()
    if text.upper() in {"RT", "BP"}:
        return text.upper()
    match = _NUMBER_RE.match(text)
    if not match:
        return value
    num_s, unit = match.group(1), (match.group(2) or "").lower()
    try:
        number: float | int
        if "." in num_s or "e" in num_s.lower():
            number = float(num_s)
        else:
            number = int(num_s)
    except ValueError:
        return value
    # Unit tags are accepted but do not convert (g/ml already match domain units).
    _ = unit
    return number


def _normalize_temp(value: Any) -> Any:
    if isinstance(value, str):
        upper = value.strip().upper()
        if upper in {"RT", "BP"}:
            return upper
        # "93C" / "93°C"
        cleaned = value.strip().replace("°", "")
        if cleaned.upper().endswith("C"):
            cleaned = cleaned[:-1]
        return _to_number(cleaned)
    return _to_number(value)


def _normalize_mapping(data: dict[str, Any], numeric_keys: set[str], temp_keys: set[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key in temp_keys:
            out[key] = _normalize_temp(value)
        elif key in numeric_keys:
            out[key] = _to_number(value)
        else:
            out[key] = value
    return out


def normalize_recipe_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow-normalized copy of a recipe candidate mapping.

    Converts common string forms like ``"15g"``, ``"93C"``, ``"3.0 ml/s"`` into
    bare numbers (or ``RT``/``BP``). Unknown shapes are left unchanged for
    subsequent schema/core validation to reject.
    """

    if not isinstance(candidate, dict):
        raise TypeError("recipe candidate must be a dict")

    kind = str(candidate.get("kind", "")).strip().lower()
    top_numeric = {
        "dose_g",
        "grind",
        "ratio",
        "water_ml",
        "hot_water_ml",
        "bypass_ml",
        "ice_g",
        "leaf_g",
        "output_ml_per_steep",
    }
    top_temp = {"bypass_temp_c"}
    out = _normalize_mapping(dict(candidate), top_numeric, top_temp)
    if "kind" in out and isinstance(out["kind"], str):
        out["kind"] = out["kind"].strip().lower()
        if out["kind"] in {"iced", "flash", "japanese-iced", "japanese-iced-coffee"}:
            out["kind"] = "flash-brew"

    pours = out.get("pours")
    if isinstance(pours, list):
        pour_numeric = {"ml", "pause_s", "rpm", "flow_ml_s"}
        pour_temp = {"temp_c"}
        normalized_pours: list[Any] = []
        for pour in pours:
            if isinstance(pour, dict):
                np = _normalize_mapping(dict(pour), pour_numeric, pour_temp)
                if isinstance(np.get("pattern"), str):
                    np["pattern"] = np["pattern"].strip().lower()
                if isinstance(np.get("vibration"), str):
                    np["vibration"] = np["vibration"].strip().lower()
                # flow may arrive as "3.2 ml/s"
                flow = np.get("flow_ml_s")
                if isinstance(flow, str) and "ml" in flow.lower():
                    np["flow_ml_s"] = _to_number(flow.replace("ml/s", "").replace("mL/s", ""))
                normalized_pours.append(np)
            else:
                normalized_pours.append(pour)
        out["pours"] = normalized_pours

    # Default dripper for coffee when omitted (core allows missing; schema recommends Omni).
    if kind in {"hot", "flash-brew", "iced", "flash"} and not out.get("dripper"):
        out["dripper"] = "Omni Dripper 2"

    return out
