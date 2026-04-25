"""NER backends — one module per backend implementation.

Each backend exposes a `predict(segments, hf_id, model_dir, progress_cb) -> tuple[list[dict], str]`
function returning (entities, model_id). Native entity-type strings are passed
through unchanged; the TypeScript-side `entity-merger.ts` performs canonical
mapping based on `metadata.backend` in the sidecar output.
"""
