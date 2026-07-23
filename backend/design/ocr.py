"""Local OCR adapter for text-mode design (never transmits image bytes).

Uses pytesseract when available. Capability absence surfaces as a clear
configuration/capability error rather than silent fallback to vision or empty text.

Production pytesseract calls use a bounded subprocess timeout so a hung OCR
binary cannot pin the worker; timeouts map to ``DesignTimeoutError``.
"""

from __future__ import annotations

from typing import Protocol

from design.config import DEFAULT_OCR_TIMEOUT_S
from design.errors import DesignConfigError, DesignTimeoutError
from design.image_processing import SanitizedImage, decode_for_ocr


class OcrAdapter(Protocol):
    """Local OCR capability used only in ``text`` design mode."""

    def extract_text(self, image: SanitizedImage, *, timeout_s: float | None = None) -> str:
        """Return plain text extracted from *image* (sanitized bytes only)."""


class PytesseractOcrAdapter:
    """OCR via pytesseract + Pillow (in-memory; no temp files)."""

    def __init__(self, *, default_timeout_s: float = DEFAULT_OCR_TIMEOUT_S) -> None:
        self.default_timeout_s = default_timeout_s

    def extract_text(self, image: SanitizedImage, *, timeout_s: float | None = None) -> str:
        try:
            import pytesseract
        except ImportError as exc:
            raise DesignConfigError(
                "text design mode with an image requires pytesseract; "
                "install the package and a Tesseract OCR binary, or use vision mode",
                code="ocr_unavailable",
                details={"dependency": "pytesseract"},
            ) from exc

        effective_timeout = self.default_timeout_s if timeout_s is None else timeout_s
        # pytesseract accepts int|float; keep a positive floor so 0 does not disable kill.
        if effective_timeout is not None and effective_timeout <= 0:
            effective_timeout = self.default_timeout_s

        pil_image = None
        try:
            pil_image = decode_for_ocr(image)
            try:
                text = pytesseract.image_to_string(pil_image, timeout=effective_timeout)
            except pytesseract.TesseractNotFoundError as exc:
                raise DesignConfigError(
                    "Tesseract OCR binary not found; install tesseract or use vision mode",
                    code="ocr_unavailable",
                    details={"dependency": "tesseract"},
                ) from exc
            except pytesseract.TesseractError as exc:
                raise DesignConfigError(
                    f"OCR failed: {exc}",
                    code="ocr_failed",
                    details={"dependency": "tesseract"},
                ) from exc
            except RuntimeError as exc:
                # pytesseract raises RuntimeError when the subprocess hits *timeout*.
                msg = str(exc).lower()
                if "timeout" in msg or "timed out" in msg:
                    raise DesignTimeoutError(
                        f"OCR exceeded {effective_timeout}s",
                        details={
                            "timeout_s": effective_timeout,
                            "stage": "ocr",
                        },
                    ) from exc
                raise DesignConfigError(
                    f"OCR failed: {exc}",
                    code="ocr_failed",
                    details={"dependency": "tesseract"},
                ) from exc
        finally:
            if pil_image is not None:
                try:
                    pil_image.close()
                except Exception:
                    pass

        if not isinstance(text, str):
            text = str(text or "")
        return text.strip()


def default_ocr_adapter(*, default_timeout_s: float = DEFAULT_OCR_TIMEOUT_S) -> OcrAdapter:
    return PytesseractOcrAdapter(default_timeout_s=default_timeout_s)
