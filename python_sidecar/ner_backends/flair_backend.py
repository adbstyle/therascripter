"""flair NER backend — uses flair/ner-german-large by default.

Native entity types: PER, LOC, MISC, ORG. (ORG is filtered TS-side per
Decision #5/#158.)
"""

import logging
import os
import sys
from typing import Callable


def predict(
    segments: list[dict],
    hf_id: str,
    model_dir: str,
    progress_cb: Callable[[int], None],
) -> list[dict]:
    # Heavy imports inside predict() — only loaded when this backend is selected.
    import flair
    from flair.data import Sentence
    from flair.nn import Classifier

    # Redirect flair's logger from stdout to stderr so JSON output stays clean.
    flair.logger.handlers.clear()
    flair.logger.addHandler(logging.StreamHandler(sys.stderr))

    # flair caches under FLAIR_CACHE_ROOT; point it at our model directory.
    os.environ["FLAIR_CACHE_ROOT"] = model_dir

    progress_cb(10)

    tagger = Classifier.load(hf_id)

    progress_cb(25)

    entities: list[dict] = []
    total = len(segments)
    for idx, segment in enumerate(segments):
        text = segment.get("text", "")
        if not text.strip():
            continue

        sentence = Sentence(text)
        tagger.predict(sentence)

        for entity in sentence.get_spans("ner"):
            entities.append(
                {
                    "text": entity.text,
                    "type": entity.get_label("ner").value,
                    "segmentIndex": idx,
                    "charStart": entity.start_position,
                    "charEnd": entity.end_position,
                    "confidence": round(entity.get_label("ner").score, 4),
                }
            )

        # Progress: 25-95% mapped to segment processing
        pct = 25 + int((idx + 1) / total * 70)
        progress_cb(min(pct, 95))

    return entities
