"""In-memory image validation, EXIF orientation, and metadata stripping.

Never persists raw or sanitized image bytes to disk. Re-encoding with Pillow
strips EXIF and other embedded metadata before any provider transmission.

Decoded dimensions are checked **before** ``img.load()`` so decompression bombs
above our pixel budget never allocate. Declared MIME is verified against the
actual decoded format rather than trusting the upload header alone.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

from design.errors import DesignValidationError

_FORMAT_FOR_MIME = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}
_MIME_FOR_FORMAT = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "WEBP": "image/webp",
}
# Pillow may report JFIF-related aliases; normalize before compare.
_FORMAT_ALIASES = {
    "JPG": "JPEG",
    "JPEG": "JPEG",
    "MPO": "JPEG",  # multi-picture JPEG object; treat as JPEG family when declared jpeg
    "PNG": "PNG",
    "WEBP": "WEBP",
}


@dataclass(frozen=True)
class SanitizedImage:
    """EXIF-stripped image ready for vision providers (in-memory only)."""

    data: bytes
    mime_type: str
    width: int
    height: int
    original_byte_length: int


def _normalize_mime(content_type: str | None) -> str:
    if not content_type:
        raise DesignValidationError(
            "image Content-Type is required",
            code="unsupported_image_type",
        )
    mime = content_type.split(";")[0].strip().lower()
    if not mime:
        raise DesignValidationError(
            "image Content-Type is required",
            code="unsupported_image_type",
        )
    return mime


def _pixel_count_or_reject(width: int, height: int, max_pixels: int) -> int:
    if width <= 0 or height <= 0:
        raise DesignValidationError("image has invalid dimensions", code="invalid_image")
    # Avoid overflow on pathological headers: reject if width > max_pixels / height.
    if width > max_pixels or height > max_pixels:
        raise DesignValidationError(
            f"image exceeds max decoded pixels ({max_pixels})",
            code="image_too_many_pixels",
            details={
                "max_pixels": max_pixels,
                "width": width,
                "height": height,
            },
            status_code=400,
        )
    pixels = width * height
    if pixels > max_pixels:
        raise DesignValidationError(
            f"image exceeds max decoded pixels ({max_pixels})",
            code="image_too_many_pixels",
            details={
                "max_pixels": max_pixels,
                "width": width,
                "height": height,
                "pixels": pixels,
            },
        )
    return pixels


def _verify_decoded_format(img: Image.Image, declared_mime: str) -> str:
    """Ensure Pillow's decoded format matches the declared allowed MIME family."""

    expected = _FORMAT_FOR_MIME.get(declared_mime)
    if expected is None:
        raise DesignValidationError(
            f"unsupported image MIME type: {declared_mime}",
            code="unsupported_image_type",
            details={"got": declared_mime},
        )
    raw_format = (img.format or "").upper()
    if not raw_format:
        raise DesignValidationError(
            "image format could not be determined after decode",
            code="invalid_image",
            details={"reason": "unknown_format", "declared_mime": declared_mime},
        )
    normalized = _FORMAT_ALIASES.get(raw_format, raw_format)
    # MPO is only accepted when the client declared JPEG.
    if normalized != expected:
        raise DesignValidationError(
            f"decoded image format {raw_format!r} does not match declared MIME {declared_mime}",
            code="invalid_image",
            details={
                "reason": "mime_format_mismatch",
                "declared_mime": declared_mime,
                "decoded_format": raw_format,
                "expected_format": expected,
            },
        )
    return expected


def sanitize_image(
    raw: bytes,
    *,
    content_type: str | None,
    allowed_mime: frozenset[str],
    max_bytes: int,
    max_pixels: int,
) -> SanitizedImage:
    """Validate MIME/bytes/pixels, normalize orientation, strip EXIF via re-encode."""

    mime = _normalize_mime(content_type)
    if mime not in allowed_mime:
        raise DesignValidationError(
            f"unsupported image MIME type: {mime}",
            code="unsupported_image_type",
            details={"allowed": sorted(allowed_mime), "got": mime},
        )
    if not raw:
        raise DesignValidationError("image is empty", code="invalid_image")
    if len(raw) > max_bytes:
        raise DesignValidationError(
            f"image exceeds max size of {max_bytes} bytes",
            code="image_too_large",
            details={"max_bytes": max_bytes, "got_bytes": len(raw)},
            status_code=413,
        )

    try:
        with Image.open(io.BytesIO(raw)) as img:
            # Header dimensions before full pixel decode / allocation.
            header_w, header_h = img.size
            _pixel_count_or_reject(header_w, header_h, max_pixels)
            out_format = _verify_decoded_format(img, mime)

            # Full decode only after dimension + format gates.
            img.load()

            # Normalize orientation using EXIF then discard EXIF by re-encoding.
            oriented = ImageOps.exif_transpose(img)
            if oriented is None:
                oriented = img
            width, height = oriented.size
            _pixel_count_or_reject(width, height, max_pixels)

            if oriented.mode not in ("RGB", "L"):
                # Drop alpha / exotic modes so JPEG path is safe; PNG/WEBP keep RGBA when possible.
                if out_format == "JPEG":
                    oriented = oriented.convert("RGB")
                elif oriented.mode not in ("RGB", "RGBA", "L"):
                    oriented = oriented.convert("RGB")

            buf = io.BytesIO()
            save_kwargs: dict[str, object] = {}
            if out_format == "JPEG":
                save_kwargs.update({"quality": 90, "optimize": True})
            # Explicitly do not pass exif= — re-encode without metadata.
            oriented.save(buf, format=out_format, **save_kwargs)
            sanitized = buf.getvalue()
            out_mime = _MIME_FOR_FORMAT[out_format]
    except DesignValidationError:
        raise
    except Image.DecompressionBombError as exc:
        raise DesignValidationError(
            f"image exceeds max decoded pixels ({max_pixels})",
            code="image_too_many_pixels",
            details={"max_pixels": max_pixels, "reason": "decompression_bomb"},
        ) from exc
    except UnidentifiedImageError as exc:
        raise DesignValidationError(
            "image could not be decoded",
            code="invalid_image",
            details={"reason": "unidentified"},
        ) from exc
    except OSError as exc:
        raise DesignValidationError(
            "image could not be decoded",
            code="invalid_image",
            details={"reason": type(exc).__name__},
        ) from exc
    except ValueError as exc:
        # Pillow raises ValueError for some corrupt / truncated payloads.
        raise DesignValidationError(
            "image could not be decoded",
            code="invalid_image",
            details={"reason": type(exc).__name__},
        ) from exc

    if len(sanitized) > max_bytes:
        # Re-encoded payload should rarely exceed original budget; fail closed.
        raise DesignValidationError(
            f"sanitized image exceeds max size of {max_bytes} bytes",
            code="image_too_large",
            details={"max_bytes": max_bytes, "got_bytes": len(sanitized)},
            status_code=413,
        )

    return SanitizedImage(
        data=sanitized,
        mime_type=out_mime,
        width=width,
        height=height,
        original_byte_length=len(raw),
    )


def decode_for_ocr(sanitized: SanitizedImage) -> Image.Image:
    """Open a sanitized image as a Pillow Image for local OCR (caller owns lifecycle)."""

    return Image.open(io.BytesIO(sanitized.data))
