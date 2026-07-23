"""AI recipe design service (Phase B).

Typed ``POST /api/design`` orchestration: knowledge loading, image sanitization,
provider adapter, strict schema + core validation. Provider output never reaches
BLE or catalog storage in this batch (B1–B7).
"""

from __future__ import annotations

from design.service import (
    DesignService,
    design_env_configured,
    design_service_from_env,
    initialize_design_service_from_env,
)

__all__ = [
    "DesignService",
    "design_env_configured",
    "design_service_from_env",
    "initialize_design_service_from_env",
]
