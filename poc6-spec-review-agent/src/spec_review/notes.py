"""Part 3: a summary per page and a glossary, written to files once and read back by the review.

The notes are built by a cheap model (Haiku 5.5) and checked by code: a summary must keep every ID and every number
of its page, and the glossary must name every term, role, state, message and mail the spec defines. A note that
loses a fact gets one retry with the missing facts named; what is still missing after the retry is appended by code
as the original lines, so no fact can be lost silently. The notes are rebuilt only when the spec changes (hash).
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .pricing import cost_usd, usage_dict
from .spec import ID_PATTERN, Page, Spec

NOTES_DIR = Path(__file__).resolve().parents[2] / "notes"
NOTES_MODEL = "claude-haiku-5-5"

SUMMARY_PROMPT = """\
You write the working notes of a specification review. Summarise ONE page of a Japanese screen specification (仕様書)
in Japanese, as short markdown bullet lines, so that a reviewer who has not read the page can compare it with other
pages.

Rules:
- Keep every ID of the page (SC-05-R01, CMN-A06, MSG-E005, MAIL-01 ...) exactly as written, one bullet per ID.
- Keep every number, limit, format, time, state name, role name and message ID exactly as written (30分, 14日,
  YYYY/MM/DD, 10桁, 貸出可 ...). Never round, convert or merge two values.
- Keep vague words exactly as written (一定回数, 適宜, 適切に, 夜間, 高速) and do not resolve them.
- Do not judge, do not point out problems, do not add anything the page does not say.
- Drop only wording: polite phrases, repeated column names, the 種類 column of plain text fields.
Answer with the markdown only, starting with "# <page ID> <title>"."""

GLOSSARY_PROMPT = """\
You write the glossary of a Japanese screen specification (仕様書) for the reviewers. From all pages below, list in
Japanese markdown:
## ロール: each role with its ID and one line.
## 状態: every state value, grouped by the state it belongs to (備品状態, 申請状態 ...), with the ID that defines the
   group, and every page ID that uses a state value not in its group, as written.
## 画面: each screen ID with its name.
## メッセージ: each MSG ID with its type and words.
## メール: each MAIL ID with its name, as defined, and every page ID that uses a MAIL ID.
## 用語: each OVR-T term with its definition.
Keep IDs and values exactly as written. Do not judge and do not point out problems."""


def spec_hash(spec: Spec) -> str:
    h = hashlib.sha256()
    for p in spec.pages.values():
        h.update(p.page_id.encode() + b"\0" + p.text.encode() + b"\0")
    return h.hexdigest()[:16]


def page_ids(page: Page) -> set[str]:
    return {m.group(1) for m in ID_PATTERN.finditer(page.text)} | {page.page_id}


_NUMBER = re.compile(r"\d+(?::\d+)?")


def _numbers(text: str) -> set[str]:
    text = ID_PATTERN.sub(" ", text)
    text = re.sub(r"^\s*\d+\.\s", " ", text, flags=re.M)  # ordered list markers are not facts
    return set(_NUMBER.findall(text))


def page_numbers(page: Page) -> set[str]:
    """Numbers outside IDs and list markers, e.g. 30 in 30分 and 8:00 in 8:00〜20:00."""
    return _numbers(page.text)


def missing_facts(page: Page, summary: str) -> list[str]:
    """IDs and numbers of the page that the summary lost. Code, not a model, decides what was lost."""
    summary_ids = {m.group(1) for m in ID_PATTERN.finditer(summary)}
    lost = sorted(page_ids(page) - summary_ids - {page.page_id})
    lost += sorted(page_numbers(page) - _numbers(summary))
    return lost


def glossary_terms(spec: Spec) -> set[str]:
    """IDs the glossary must name: roles, terms, role matrix rows, messages, mails and screens."""
    defined = {i for i in spec.defined_ids if re.match(r"OVR-[RT]\d{2}|CMN-A\d{2}|MSG-|MAIL-", i)}
    used_mail = {i for i in spec.all_ids if i.startswith("MAIL-")}
    screens = {p for p in spec.pages if p.startswith("SC-")}
    return defined | used_mail | screens


def missing_terms(spec: Spec, glossary: str) -> list[str]:
    named = {m.group(1) for m in ID_PATTERN.finditer(glossary)}
    return sorted(glossary_terms(spec) - named)


def lines_with(page: Page, facts: list[str]) -> list[str]:
    """The original lines of the page that hold the given IDs or numbers: the code fallback for lost facts."""
    out = []
    for line in page.text.splitlines():
        if any(re.search(rf"(?<![A-Z0-9-]){re.escape(f)}(?![0-9])", line) for f in facts) and line not in out:
            out.append(line)
    return out


@dataclass
class NoteResult:
    name: str
    text: str
    lost_first: list[str]
    lost_after_retry: list[str]
    appended_lines: int
    usage: dict[str, int]
    cost_usd: float


def _ask(client: Any, model: str, system: str, user: str, effort: str) -> tuple[str, dict[str, int]]:
    request = {"model": model, "max_tokens": 16000, "system": system,
               "messages": [{"role": "user", "content": user}], "output_config": {"effort": effort}}
    with client.messages.stream(**request) as s:
        msg = s.get_final_message()
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    return text, usage_dict(msg.usage)


def _add(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    return {k: a.get(k, 0) + b.get(k, 0) for k in set(a) | set(b)}


def summarise_page(client: Any, page: Page, model: str = NOTES_MODEL, effort: str = "low") -> NoteResult:
    user = f'<page id="{page.page_id}">\n{page.text}\n</page>'
    text, usage = _ask(client, model, SUMMARY_PROMPT, user, effort)
    lost_first = missing_facts(page, text)
    lost = lost_first
    if lost:
        retry = (user + "\n\nYour previous summary lost these IDs or numbers: " + ", ".join(lost)
                 + ". Write the whole summary again and keep all of them.\n\n<previous>\n" + text + "\n</previous>")
        text2, u2 = _ask(client, model, SUMMARY_PROMPT, retry, effort)
        usage = _add(usage, u2)
        lost2 = missing_facts(page, text2)
        if len(lost2) <= len(lost):
            text, lost = text2, lost2
    appended = 0
    if lost:
        extra = lines_with(page, lost)
        appended = len(extra)
        text += "\n\n## 原文（要約で欠落した行）\n" + "\n".join(extra)
    return NoteResult(page.page_id, text, lost_first, lost, appended, usage, cost_usd(model, usage))


def build_glossary(client: Any, spec: Spec, model: str = NOTES_MODEL, effort: str = "low") -> NoteResult:
    user = "\n\n".join(f'<page id="{p.page_id}">\n{p.text}\n</page>' for p in spec.pages.values())
    text, usage = _ask(client, model, GLOSSARY_PROMPT, user, effort)
    lost_first = missing_terms(spec, text)
    lost = lost_first
    if lost:
        retry = user + "\n\nYour previous glossary did not name: " + ", ".join(lost) + ". Write it again with them."
        text2, u2 = _ask(client, model, GLOSSARY_PROMPT, retry, effort)
        usage = _add(usage, u2)
        lost2 = missing_terms(spec, text2)
        if len(lost2) <= len(lost):
            text, lost = text2, lost2
    appended = 0
    if lost:
        extra = [line for p in spec.pages.values() for line in lines_with(p, lost)]
        appended = len(extra)
        text += "\n\n## 原文（用語集で欠落した行）\n" + "\n".join(extra)
    return NoteResult("glossary", text, lost_first, lost, appended, usage, cost_usd(model, usage))


@dataclass
class Notes:
    """The notes on disk. `index` is every summary in page order: the map of the spec."""
    summaries: dict[str, str]
    glossary: str
    manifest: dict[str, Any]

    @property
    def index(self) -> str:
        return "\n\n".join(self.summaries.values())

    def names(self) -> list[str]:
        return ["index", "glossary", *self.summaries]

    def get(self, name: str) -> str | None:
        if name == "index":
            return self.index
        if name == "glossary":
            return self.glossary
        return self.summaries.get(name)


def load_notes(spec: Spec, notes_dir: Path = NOTES_DIR) -> Notes | None:
    """The notes, or None when they are missing or were built from another version of the spec."""
    manifest_path = notes_dir / "manifest.json"
    if not manifest_path.exists():
        return None
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("spec_hash") != spec_hash(spec):
        return None
    summaries = {p: (notes_dir / "summaries" / f"{p}.md").read_text(encoding="utf-8") for p in spec.page_ids}
    return Notes(summaries, (notes_dir / "glossary.md").read_text(encoding="utf-8"), manifest)


def build_notes(client: Any, spec: Spec, notes_dir: Path = NOTES_DIR, model: str = NOTES_MODEL,
                effort: str = "low") -> tuple[Notes, float]:
    """Build every note and write it. Returns the notes and the cost of this build."""
    (notes_dir / "summaries").mkdir(parents=True, exist_ok=True)
    results = [summarise_page(client, p, model, effort) for p in spec.pages.values()]
    results.append(build_glossary(client, spec, model, effort))
    for r in results:
        path = notes_dir / ("glossary.md" if r.name == "glossary" else f"summaries/{r.name}.md")
        path.write_text(r.text.rstrip() + "\n", encoding="utf-8")
    cost = sum(r.cost_usd for r in results)
    manifest = {
        "spec_hash": spec_hash(spec), "model": model, "effort": effort, "cost_usd": round(cost, 5),
        "spec_chars": sum(len(p.text) for p in spec.pages.values()),
        "notes": {r.name: {"chars": len(r.text), "lost_first": r.lost_first, "lost_after_retry": r.lost_after_retry,
                           "appended_lines": r.appended_lines, "output_tokens": r.usage.get("output_tokens", 0),
                           "cost_usd": round(r.cost_usd, 5)} for r in results},
    }
    (notes_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    notes = load_notes(spec, notes_dir)
    assert notes is not None
    return notes, cost


_SEARCH_LIMIT = 40


def search_spec(spec: Spec, pattern: str, limit: int = _SEARCH_LIMIT) -> tuple[list[str], str | None]:
    """Grep over the spec: matching lines as `PAGE:line: text`. Returns (lines, error)."""
    try:
        rx = re.compile(pattern)
    except re.error as e:
        return [], f"Invalid regular expression: {e}"
    out = []
    for p in spec.pages.values():
        for n, line in enumerate(p.text.splitlines(), 1):
            if rx.search(line):
                out.append(f"{p.page_id}:{n}: {line}")
    if len(out) > limit:
        return out[:limit] + [f"... {len(out) - limit} more lines; narrow the pattern"], None
    return out, None

