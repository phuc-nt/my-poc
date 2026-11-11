"""The 質問表 (question list) schema.

Two forms of one contract:
- `question_list_schema(page_ids)`: a hand-written JSON Schema that stays inside the strict-mode subset
  (no minLength/maximum, every property required, nullable as anyOf string/null, additionalProperties false).
- `QuestionList` (Pydantic): the same shape plus the checks strict mode cannot express. Code then adds
  the semantic checks that need the spec (IDs exist, page names are real).
"""

from __future__ import annotations

import unicodedata
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .spec import Spec


class Kind(str, Enum):
    missing = "missing"
    contradiction = "contradiction"
    ambiguous = "ambiguous"


class Severity(str, Enum):
    critical = "critical"
    major = "major"
    minor = "minor"


class Location(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: str
    item_ids: list[str] = Field(min_length=1, max_length=8)
    section: str | None


class QuestionItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=r"^Q\d{3}$")
    location: Location
    kind: Kind
    severity: Severity
    issue: str = Field(min_length=5, max_length=400)
    question: str = Field(min_length=5, max_length=400)
    spec_quote: str | None = Field(max_length=300)
    proposed_answer: str | None = Field(max_length=300)

    @field_validator("question")
    @classmethod
    def question_is_japanese(cls, v: str) -> str:
        if not any("぀" <= ch <= "ヿ" or "一" <= ch <= "鿿" for ch in v):
            raise ValueError("question must be written in Japanese")
        return v


class QuestionList(BaseModel):
    model_config = ConfigDict(extra="forbid")
    questions: list[QuestionItem] = Field(min_length=1, max_length=60)


def question_list_schema(page_ids: list[str], min_questions: int = 1) -> dict[str, Any]:
    nullable_str = {"anyOf": [{"type": "string"}, {"type": "null"}]}
    location = {
        "type": "object",
        "properties": {
            "page": {"type": "string", "enum": page_ids, "description": "Page ID, e.g. SC-05 or CMN."},
            "item_ids": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 1,
                "description": "IDs of the items the question is about, copied from the spec (e.g. SC-05-R01, CMN-A06). "
                "For a contradiction, list the items on both sides.",
            },
            "section": {**nullable_str, "description": "Section heading ID such as SC-05-3, or null."},
        },
        "required": ["page", "item_ids", "section"],
        "additionalProperties": False,
    }
    item = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "Q001, Q002, ... in order."},
            "location": location,
            "kind": {"type": "string", "enum": [k.value for k in Kind]},
            "severity": {"type": "string", "enum": [s.value for s in Severity]},
            "issue": {"type": "string", "description": "What is wrong, in Japanese, one or two sentences."},
            "question": {"type": "string", "description": "The question to the customer, in polite Japanese."},
            "spec_quote": {**nullable_str, "description": "The exact words of the spec at issue; null when the spec says nothing."},
            "proposed_answer": {**nullable_str, "description": "A suggested answer the customer can accept, or null."},
        },
        "required": ["id", "location", "kind", "severity", "issue", "question", "spec_quote", "proposed_answer"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {"questions": {"type": "array", "items": item, "minItems": min_questions}},
        "required": ["questions"],
        "additionalProperties": False,
    }


def _plain(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split())


def quote_in_spec(quote: str, spec: Spec) -> bool:
    """True when the quote occurs in some page, ignoring only width and runs of white space."""
    q = _plain(quote)
    return any(q in _plain(p.text) for p in spec.pages.values())


def validate_question_list(data: Any, spec: Spec, check_quotes: bool = False,
                           allow_empty: bool = False) -> tuple[QuestionList | None, list[str]]:
    """Return the parsed list and an empty error list, or None and errors written for the model to fix.

    check_quotes (part 4): every spec_quote must occur in the spec as written; a reworded quote is an error.
    allow_empty (part 4, one screen per request): a screen with no problem answers with an empty list."""
    if allow_empty and isinstance(data, dict) and data.get("questions") == [] and set(data) == {"questions"}:
        return QuestionList.model_construct(questions=[]), []
    try:
        parsed = QuestionList.model_validate(data)
    except ValidationError as exc:
        errors = []
        for err in exc.errors()[:20]:
            loc = ".".join(str(p) for p in err["loc"])
            errors.append(f"{loc}: {err['msg']}")
        return None, errors

    errors = []
    seen: set[str] = set()
    for q in parsed.questions:
        if q.id in seen:
            errors.append(f"{q.id}: duplicate id")
        seen.add(q.id)
        if q.location.page not in spec.pages:
            errors.append(f"{q.id}.location.page: unknown page {q.location.page!r}")
        for item_id in q.location.item_ids:
            if item_id not in spec.all_ids:
                errors.append(f"{q.id}.location.item_ids: {item_id!r} does not appear in the spec")
        if check_quotes and q.spec_quote and not quote_in_spec(q.spec_quote, spec):
            errors.append(f"{q.id}.spec_quote: these words do not occur in the spec. Copy one passage exactly as "
                          "written (no added or removed punctuation, no joined passages), or use null")
    return (None, errors) if errors else (parsed, [])
