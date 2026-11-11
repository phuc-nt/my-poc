"""Load the synthetic specification and index the IDs it uses.

Every checkable thing in the spec carries an explicit ID (SC-05-R01, CMN-A06, MSG-E005, MAIL-01 ...).
The index lets code, not the model, check that a question points at something that exists.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

SPEC_DIR = Path(__file__).resolve().parents[2] / "spec"

_ID = (
    r"SC-\d{2}-[FR]\d{2}|SC-\d{2}-\d|SC-\d{2}"
    r"|CMN-[RA]\d{2}|CMN-\d"
    r"|OVR-[RTN]\d{2}|OVR-\d"
    r"|MSG-[EIC]\d{3}|MAIL-\d{2}"
)
ID_PATTERN = re.compile(rf"(?<![A-Z0-9-])({_ID})(?![0-9])")
# An ID is "defined" where it opens a table row or a heading; anywhere else it is a reference.
DEFINED_PATTERN = re.compile(rf"^(?:\|\s*|#+\s*)({_ID})(?![0-9])", re.M)


@dataclass
class Page:
    page_id: str
    title: str
    text: str


@dataclass
class Spec:
    pages: dict[str, Page]
    all_ids: set[str] = field(default_factory=set)
    defined_ids: set[str] = field(default_factory=set)

    @property
    def page_ids(self) -> list[str]:
        return list(self.pages)

    def undefined_references(self) -> set[str]:
        """IDs used somewhere but defined nowhere (screen IDs count as defined by their page)."""
        return {i for i in self.all_ids if i not in self.defined_ids and i not in self.pages}


def load_spec(spec_dir: Path = SPEC_DIR) -> Spec:
    pages: dict[str, Page] = {}
    for path in sorted(spec_dir.glob("*.md"), key=_page_order):
        text = path.read_text(encoding="utf-8")
        first = text.splitlines()[0].lstrip("# ").strip()
        pages[path.stem] = Page(page_id=path.stem, title=first, text=text)
    spec = Spec(pages=pages)
    for page in pages.values():
        spec.all_ids.update(m.group(1) for m in ID_PATTERN.finditer(page.text))
        spec.defined_ids.update(m.group(1) for m in DEFINED_PATTERN.finditer(page.text))
    spec.all_ids.update(pages)
    return spec


def _page_order(path: Path) -> tuple[int, str]:
    head = {"OVR": 0, "CMN": 1}
    return (head.get(path.stem, 2), path.stem)
