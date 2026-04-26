import { z } from 'zod'

/**
 * Single source of truth for the LLM summarization output shape.
 *
 * Two artifacts derive from this file:
 *  1. The JSON Schema string passed to llama-cli via `--json-schema`. The
 *     llama.cpp grammar engine constrains token sampling so the model can
 *     ONLY emit tokens that lead to a valid JSON document matching the
 *     schema. This eliminates format-following risk entirely — the model
 *     is physically incapable of producing prose, headers, markdown, or
 *     any other non-JSON output.
 *  2. The Zod validator used in `LlamaSummarizer.parseLlamaOutput` for
 *     defense-in-depth. Even if the grammar engine somehow produced
 *     malformed JSON (it shouldn't), Zod catches it and surfaces a typed
 *     error.
 *
 * The numeric bounds protect downstream UI + DB columns from oversized
 * blobs (e.g. a runaway model emitting a 50k-char summary). These bounds
 * are intentionally tighter than the IPC update bounds in
 * `summary-schemas.ts` (TITLE_MAX=80 vs MAX_TITLE_CHARS=120;
 * SUMMARY_MAX=1_000 vs MAX_SUMMARY_CHARS=2_000): the LLM should produce
 * terse output, while a user editing in the Review Editor may legitimately
 * expand it within the looser IPC limits.
 */

const TITLE_MAX = 80
const SUMMARY_MAX = 1_000

export const SummarizationOutputSchema = z.object({
  title: z.string().min(3).max(TITLE_MAX),
  summary: z.string().min(20).max(SUMMARY_MAX)
})

export type SummarizationOutput = z.infer<typeof SummarizationOutputSchema>

/**
 * JSON Schema string for llama-cli's `--json-schema` flag. Hand-written
 * (instead of derived via zod-to-json-schema) to keep this file
 * dependency-free and the constraint surface explicit + auditable.
 *
 * Keep in sync with `SummarizationOutputSchema` above. The unit test in
 * `__tests__/summarization-schema.test.ts` verifies both definitions
 * agree on the same accept/reject set.
 */
export const SUMMARIZATION_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 3, maxLength: TITLE_MAX },
    summary: { type: 'string', minLength: 20, maxLength: SUMMARY_MAX }
  },
  required: ['title', 'summary'],
  additionalProperties: false
})
