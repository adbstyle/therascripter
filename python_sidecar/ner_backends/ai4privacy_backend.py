"""ai4privacy NER backend — uses ai4privacy/llama-...-openpii (ModernBERT-based).

Despite the "llama-" prefix, the model is a ModernBERT-base token-classifier
(~100M params, ~400 MB on disk). Native entity types (21 classes):
GIVENNAME, SURNAME, TITLE, CITY, STREET, BUILDINGNUM, ZIPCODE, EMAIL,
TELEPHONENUM, DATE, TIME, AGE, SEX, GENDER, CREDITCARDNUMBER, SOCIALNUM,
IDCARDNUM, PASSPORTNUM, DRIVERLICENSENUM, TAXNUM, O.

The TypeScript-side `mapAi4PrivacyType` maps these to canonical PlaceholderType
values (see entity-merger.ts).
"""

from typing import Callable


def predict(
    segments: list[dict],
    hf_id: str,
    model_dir: str,
    progress_cb: Callable[[int], None],
) -> list[dict]:
    # Heavy imports inside predict() — only loaded when this backend is selected.
    from transformers import AutoModelForTokenClassification, AutoTokenizer, pipeline

    progress_cb(10)

    tokenizer = AutoTokenizer.from_pretrained(
        hf_id,
        cache_dir=model_dir,
        local_files_only=True,
    )
    model = AutoModelForTokenClassification.from_pretrained(
        hf_id,
        cache_dir=model_dir,
        local_files_only=True,
    )

    progress_cb(20)

    # aggregation_strategy="simple" merges B-/I- subword tokens back into spans.
    ner = pipeline(
        "ner",
        model=model,
        tokenizer=tokenizer,
        aggregation_strategy="simple",
    )

    progress_cb(25)

    entities: list[dict] = []
    total = len(segments)
    for idx, segment in enumerate(segments):
        text = segment.get("text", "")
        if not text.strip():
            continue

        spans = ner(text)

        # transformers pipeline returns dicts with keys: entity_group, score, word, start, end
        for span in spans:
            entity_group = span.get("entity_group") or span.get("entity", "")
            entities.append(
                {
                    "text": span.get("word", text[int(span["start"]) : int(span["end"])]),
                    "type": entity_group,
                    "segmentIndex": idx,
                    "charStart": int(span["start"]),
                    "charEnd": int(span["end"]),
                    "confidence": round(float(span["score"]), 4),
                }
            )

        # Progress: 25-95% mapped to segment processing
        pct = 25 + int((idx + 1) / total * 70)
        progress_cb(min(pct, 95))

    return entities
