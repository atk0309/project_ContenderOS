"""PDF → text (pypdf) for the ingestion audit/evidence copy + a page-and-size guard.

This is NOT the extraction path — the Extractor reads the PDF natively as a Claude `document` block
(ADR 0007: pypdf garbles multi-column and can't OCR scanned CVs). pypdf is used here only to (1) cap
the upload before it reaches the model (bytes + pages) and (2) produce a best-effort plain-text copy
stored on the run for evidence-verification (`_evidence`) and as the text-only fallback corpus when
the native call fails. Empty text is a valid outcome (a scanned PDF) — not an error.

Framework-agnostic by design (no FastAPI import): the route maps these exceptions to HTTP statuses
(`PdfTooLarge`/`PdfTooManyPages` → 413, `PdfUnreadable` → 422). `extract_pdf_text` is CPU-bound;
callers run it in a threadpool so it can't block the event loop.
"""

from __future__ import annotations

import io

from pypdf import PdfReader

# Caps (module constants, not env — see the plan's doc-impact: keeps `env-vars-changed` dark). The
# native path base64-inflates bytes ~33% before they reach Anthropic; 10 MiB / 30 pages sits well
# under Anthropic's documented PDF ceilings (~32 MB / 100 pages) with margin.
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 30


class PdfTooLarge(Exception):
    """The upload exceeds the byte cap (→ 413)."""

    def __init__(self) -> None:
        super().__init__(f"PDF is too large (max {MAX_PDF_BYTES // (1024 * 1024)} MB)")


class PdfTooManyPages(Exception):
    """The PDF has more pages than we'll process (→ 413)."""

    def __init__(self) -> None:
        super().__init__(f"PDF has too many pages (max {MAX_PDF_PAGES})")


class PdfUnreadable(Exception):
    """The bytes aren't a parseable PDF — malformed, encrypted, or not a PDF at all (→ 422)."""

    def __init__(self) -> None:
        super().__init__("couldn't read that PDF — is it a valid, unprotected PDF?")


def extract_pdf_text(data: bytes) -> str:
    """Best-effort plain text from PDF bytes, enforcing the byte + page caps.

    Raises `PdfTooLarge` (bytes over cap), `PdfTooManyPages` (pages over cap), or `PdfUnreadable`
    (any parse/extract failure — pypdf raises a variety of types, so the catch is broad: a malformed
    PDF must never surface as a raw 500). Returns the concatenated page text, which may be empty for
    a scanned/image-only PDF (handled by the caller, not an error here)."""
    if len(data) > MAX_PDF_BYTES:
        raise PdfTooLarge

    try:
        reader = PdfReader(io.BytesIO(data))
        pages = reader.pages
        page_count = len(pages)
    except Exception as exc:
        raise PdfUnreadable from exc

    # Outside the broad except so it maps to 413, not 422.
    if page_count > MAX_PDF_PAGES:
        raise PdfTooManyPages

    try:
        return "\n".join((page.extract_text() or "") for page in pages)
    except Exception as exc:
        raise PdfUnreadable from exc
