"""NER backends — one module per backend implementation.

Each backend exposes a `predict(segments, hf_id, model_dir, progress_cb) -> list[dict]`
function returning detected entities in native (backend-specific) format. The
TypeScript-side `entity-merger.ts` performs canonical mapping based on the
`metadata.backend` field that the dispatcher sets in the sidecar output.

See `base.py` for the authoritative `BackendPredictFn` Protocol.
"""
