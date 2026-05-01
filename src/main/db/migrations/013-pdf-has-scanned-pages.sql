-- Migration 013: pdf_has_scanned_pages column (Issue #80 Phase G)
-- Purpose: tag PDF sessions at import time with whether they need OCR.
-- Read by computePlannedSteps() so the renderer's step counter can include
-- the OCR step (or not) before extraction has actually run.
--
-- NULL = legacy/unknown row (no detection performed). Existing PDF sessions
-- in 'review' or 'error' don't need this set; import flow populates it for
-- new sessions starting from app v0.9.0.

ALTER TABLE sessions ADD COLUMN pdf_has_scanned_pages INTEGER;
