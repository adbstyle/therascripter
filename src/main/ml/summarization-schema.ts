import { z } from 'zod'

/**
 * Single source of truth for the LLM summarization output shape.
 *
 * Two artifacts derive from the bounds below:
 *  1. The GBNF grammar passed to llama-cli via `--grammar`. The llama.cpp
 *     grammar engine constrains token sampling so the model can ONLY emit
 *     tokens that lead to a valid `{title, summary}` JSON object. This
 *     eliminates format-following risk entirely — the model is physically
 *     incapable of producing prose, headers, markdown, or any other
 *     non-JSON output.
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

export const TITLE_MIN = 3
export const TITLE_MAX = 80
export const SUMMARY_MIN = 20
export const SUMMARY_MAX = 1_000

export const SummarizationOutputSchema = z.object({
  title: z.string().min(TITLE_MIN).max(TITLE_MAX),
  summary: z.string().min(SUMMARY_MIN).max(SUMMARY_MAX)
})

export type SummarizationOutput = z.infer<typeof SummarizationOutputSchema>

/**
 * GBNF grammar for llama-cli's `--grammar` flag — exactly what llama.cpp's
 * own JSON-Schema converter emits for `{title, summary}` with the bounds
 * above (copied from its log, only the numbers are interpolated).
 *
 * Why not `--json-schema`: with Gemma 4 the bundled llama-cli (b9200) fails
 * in `common_sampler_init` ("Failed to initialize samplers") and exits 0 —
 * in the app a silent summarization skip on every session (Issue #57,
 * upstream ggml-org/llama.cpp#22396). The same grammar passed as GBNF runs
 * cleanly, so the converter is bypassed and the engine stays the same.
 *
 * `char{min,max}` counts characters, like Zod's `.min()/.max()` — an escape
 * sequence such as `\n` counts as one. Key order is fixed (title first).
 */
export const SUMMARIZATION_GBNF = String.raw`char ::= [^"\\\x7F\x00-\x1F] | [\\] (["\\bfnrt] | "u" [0-9a-fA-F]{4})
root ::= "{" space title-kv "," space summary-kv "}" space
space ::= | " " | "\n"{1,2} [ \t]{0,20}
summary ::= "\"" char{${SUMMARY_MIN},${SUMMARY_MAX}} "\"" space
summary-kv ::= "\"summary\"" space ":" space summary
title ::= "\"" char{${TITLE_MIN},${TITLE_MAX}} "\"" space
title-kv ::= "\"title\"" space ":" space title
`
