---
description: Review one screen again, given the findings of an earlier review, and report only what is new
argument-hint: <screen ID> <prior findings file>
allowed-tools: mcp__spec__read_page, Read
---

Review the screen **$0** of the Japanese screen specification (仕様書) again. An earlier review of the same screen
wrote its findings to `$1`. The team has already sent those questions; they want only what the earlier review missed.

1. Read `$1` with the Read tool. Its `questions` are the prior findings.
2. Call the MCP tool `mcp__spec__read_page` with page_id `$0`. If it returns an error, stop and report it.
3. Read `spec/OVR.md` and `spec/CMN.md` with the Read tool. When the screen is silent, CMN applies: that is not a
   problem. Report a problem that involves another page only when this screen, OVR or CMN shows both sides.
4. Apply the review policy (same finding, addressed). Put in `questions` only problems that no prior finding covers,
   numbered from Q001. Put the ID of each prior finding in `still_open` or `addressed`, never in both.

Kinds (pick exactly one):
- missing: an implementer needs a value, rule, item, screen or definition that appears nowhere in the spec
  (including CMN and OVR), or an ID is referenced but never defined.
- contradiction: two places give different values or rules for the same thing, or a value is used that is not in
  the list the spec defines for it.
- ambiguous: the spec says something, but without a value two implementers would build the same way
  (words such as 一定, 適宜, 適切, 高速, 関係者, 夜間 with no number or list).

Severity (pick exactly one):
- critical: a wrong guess breaks access control, loses or corrupts data, or changes a core business rule.
- major: an implementer or tester cannot finish the function without the answer.
- minor: a safe default exists (format, length, paging, wording, encoding) but the customer should confirm it.

Rules:
- One problem per question. For a contradiction, put the IDs of both sides in location.item_ids. location.item_ids
  holds only IDs that appear in the spec text.
- issue, question, spec_quote and proposed_answer are in Japanese; question in polite business Japanese.
  spec_quote is copied exactly from a page, or null when the spec says nothing.
- An empty `questions` list is the right answer when the earlier review missed nothing.

Answer with the structured output only. In `rule_tags`, list every "Rule tag:" value that appears in the project
instructions and rules you were given in this session (exactly as written, for example `P6-...`), and nothing else.
