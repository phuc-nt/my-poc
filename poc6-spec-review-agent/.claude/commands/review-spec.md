---
description: Review one screen of the spec and return its questions (質問表) as JSON
argument-hint: <screen ID, e.g. SC-01>
allowed-tools: mcp__spec__read_page, Read
---

Review the screen **$ARGUMENTS** of the Japanese screen specification (仕様書) in this project and write the questions
(質問表) the development team sends back to the customer before design starts.

1. Call the MCP tool `mcp__spec__read_page` with page_id `$ARGUMENTS`. If it returns an error, stop and report it.
2. Read `spec/OVR.md` and `spec/CMN.md` with the Read tool. When the screen is silent, CMN applies: that is not a problem.
3. Report a problem that involves another page only when this screen, OVR or CMN shows both sides.

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
- One problem per question, numbered Q001, Q002 ... For a contradiction, put the IDs of both sides in
  location.item_ids. location.item_ids holds only IDs that appear in the spec text.
- issue, question, spec_quote and proposed_answer are in Japanese; question in polite business Japanese.
  spec_quote is copied exactly from a page, or null when the spec says nothing.
- Do not ask about what the spec already answers somewhere else. An empty list is right for a screen with no problem.

Answer with the structured output only. In `rule_tags`, list every "Rule tag:" value that appears in the project
instructions and rules you were given in this session (exactly as written, for example `P6-...`), and nothing else.
