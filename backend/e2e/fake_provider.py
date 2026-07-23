"""Deterministic fake design provider for Phase C9 E2E.

Receives a normalized ``ProviderRequest`` (already built by DesignService) and
records the configured model plus image bytes/mime when present. Returns a fixed
valid recipe candidate. Never calls a real LLM or CLP proxy.

This fake does **not** exercise or assert ``OpenAICompatibleProvider``'s HTTP
request body (including any ``image_url`` data URL encoding). That adapter's
wire format is covered by unit tests in ``tests/test_phase_b10_design.py``.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Any

from design.provider import ProviderRequest, ProviderResponse

# Fixed valid coffee candidate used by all E2E design calls.
VALID_COFFEE_CANDIDATE: dict[str, Any] = {
    "name": "E2E Ethiopia Washed",
    "kind": "hot",
    "dripper": "Omni Dripper 2",
    "dose_g": 15,
    "grind": 58,
    "ratio": 16,
    "water_ml": 240,
    "hot_water_ml": 240,
    "time": "2:30-3:00",
    "note": "Playwright E2E deterministic candidate",
    "pours": [
        {
            "label": "Bloom",
            "ml": 45,
            "temp_c": 92,
            "pattern": "spiral",
            "vibration": "after",
            "pause_s": 35,
            "rpm": 90,
            "flow_ml_s": 3.0,
        },
        {
            "label": "Main",
            "ml": 105,
            "temp_c": 92,
            "pattern": "spiral",
            "vibration": "none",
            "pause_s": 10,
            "rpm": 90,
            "flow_ml_s": 3.2,
        },
        {
            "label": "Finish",
            "ml": 90,
            "temp_c": 91,
            "pattern": "circular",
            "vibration": "none",
            "pause_s": 0,
            "rpm": 90,
            "flow_ml_s": 3.2,
        },
    ],
}

VALID_OUTPUT: dict[str, Any] = {
    "recipe_candidate": VALID_COFFEE_CANDIDATE,
    "design_rationale": "Deterministic E2E candidate for washed light roast.",
    "evidence": [
        {
            "source": "user_text",
            "claim": "E2E fixture design notes",
            "value": "ethiopia",
        },
        {
            "source": "bag_label",
            "claim": "Bag image present for vision design",
            "value": "bag",
        },
    ],
}


@dataclass
class FakeProviderCall:
    """Ledger row: configured model + image presence from ProviderRequest."""

    model: str
    has_image: bool
    image_mime: str | None
    # Convenience encoding of ProviderRequest.image bytes for ledger display only;
    # not evidence that OpenAICompatibleProvider built an HTTP image_url body.
    image_data_url_prefix: str | None
    user_text_excerpt: str


@dataclass
class FakeOpenAICompatibleProvider:
    """In-process DesignProvider stub for E2E (not the real HTTP adapter).

    Asserts the configured model name and that vision runs receive image bytes
    on ``ProviderRequest``. Does not call or validate OpenAICompatibleProvider.
    """

    name: str = "openai-compatible"
    model: str = "grok-4.5"
    supports_vision: bool = True
    supports_structured_output: bool = True
    expected_model: str = "grok-4.5"
    require_image: bool = True
    calls: list[FakeProviderCall] = field(default_factory=list)
    last_error: str | None = None

    async def complete(self, request: ProviderRequest) -> ProviderResponse:
        model = self.model
        if model != self.expected_model:
            self.last_error = f"model must be {self.expected_model!r}, got {model!r}"
            raise AssertionError(self.last_error)

        has_image = request.image is not None
        image_mime: str | None = None
        data_url_prefix: str | None = None
        if has_image:
            assert request.image is not None
            image_mime = request.image.mime_type
            if not request.image.data:
                self.last_error = "ProviderRequest.image has empty bytes"
                raise AssertionError(self.last_error)
            # Record image bytes as a data-URL prefix for ledger snapshots only.
            b64 = base64.standard_b64encode(request.image.data).decode("ascii")
            data_url_prefix = f"data:{request.image.mime_type};base64,{b64}"[:64]
        elif self.require_image:
            self.last_error = "vision E2E design requires ProviderRequest.image bytes"
            raise AssertionError(self.last_error)

        user_text = ""
        if request.prompt is not None:
            user_text = str(getattr(request.prompt, "user_text", "") or "")

        self.calls.append(
            FakeProviderCall(
                model=model,
                has_image=has_image,
                image_mime=image_mime,
                image_data_url_prefix=data_url_prefix,
                user_text_excerpt=user_text[:200],
            )
        )

        body = dict(VALID_OUTPUT)
        text = json.dumps(body)
        return ProviderResponse(
            text=text,
            parsed=body,
            model=self.model,
            provider=self.name,
            usage={"prompt_tokens": 10, "completion_tokens": 20},
        )

    async def aclose(self) -> None:
        return None

    def call_snapshot(self) -> list[dict[str, Any]]:
        return [
            {
                "model": c.model,
                "has_image": c.has_image,
                "image_mime": c.image_mime,
                "image_data_url_prefix": c.image_data_url_prefix,
                "user_text_excerpt": c.user_text_excerpt,
            }
            for c in self.calls
        ]
