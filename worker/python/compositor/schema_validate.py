"""Validation of a timeline.json document against schema/timeline.schema.json."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import jsonschema

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_SCHEMA_PATH = REPO_ROOT / "schema" / "timeline.schema.json"


def load_schema(schema_path: Path | None = None) -> dict[str, Any]:
    path = schema_path or DEFAULT_SCHEMA_PATH
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


class TimelineValidationError(ValueError):
    """Raised when a timeline.json document fails schema validation."""


def validate_timeline(
    timeline: dict[str, Any], schema_path: Path | None = None
) -> None:
    """Validate ``timeline`` against the timeline JSON Schema.

    Raises ``TimelineValidationError`` with a human-readable message on
    failure. This must be called before any rendering is attempted so that
    malformed Studio output fails fast with a clear error instead of an
    obscure crash deep inside the compositor.
    """

    schema = load_schema(schema_path)
    validator_cls = jsonschema.validators.validator_for(schema)
    validator_cls.check_schema(schema)
    validator = validator_cls(schema)

    errors = sorted(validator.iter_errors(timeline), key=lambda e: list(e.path))
    if errors:
        lines = []
        for err in errors:
            location = "/".join(str(p) for p in err.path) or "<root>"
            lines.append(f"  - {location}: {err.message}")
        raise TimelineValidationError(
            "timeline.json failed schema validation:\n" + "\n".join(lines)
        )
