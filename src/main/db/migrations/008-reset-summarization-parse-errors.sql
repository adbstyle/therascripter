-- Targeted data repair for sessions that landed in 'error' state because the
-- legacy LLM-output parser (TITEL:/ZUSAMMENFASSUNG: regex on raw stdout) failed
-- to extract structured fields from a noisy llama-cli stream — the regex
-- required `^TITEL:` at line start but llama-cli's spinner ASCII (\r-overwrites
-- like `|-\|/-\|/`) prefixed the line in non-terminal stdout capture.
--
-- The summarization step is OPTIONAL by design ("Model-missing is a skip, not
-- a failure" — plan §35). With the architecture rewrite to JSON-Schema-driven
-- output + try/catch in the executor, future parse failures will degrade
-- silently. This migration repairs the in-place damage from the buggy version
-- so existing users don't have to manually retry every affected session.
--
-- Scope intentionally narrow:
--   1. The session must be in 'error' state.
--   2. The error_message must match the exact text produced by the old parser
--      (so we don't accidentally rescue sessions broken by genuinely different
--      pipeline failures).
--   3. The session must have a non-NULL anonymized_path (i.e. anonymization
--      succeeded — only the summarization tail step failed).
--
-- Effect:
--   - Session moves from 'error' back to 'review' so the user can open the
--     Review Editor and read the anonymized transcript.
--   - error_message cleared.
--   - sessions.summary stays NULL (no LLM-generated summary available; this
--     matches the new "skip on failure" behavior). The Review Editor's
--     SummaryPanel renders nothing in that state — feature degrades quietly.
--   - The associated task_queue rows are NOT modified — re-running summarization
--     for these sessions would require explicit user action (out of scope here).
UPDATE sessions
SET status = 'review',
    error_message = NULL,
    updated_at = datetime('now')
WHERE status = 'error'
  AND error_message LIKE 'Unerwartetes LLM-Output: TITEL oder ZUSAMMENFASSUNG fehlt%'
  AND anonymized_path IS NOT NULL;
