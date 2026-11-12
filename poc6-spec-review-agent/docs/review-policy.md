# Review policy

Rule tag: P6-IMPORT

The project CLAUDE.md imports this file, so every session in this folder carries it: the review, the re-review and
the verifier work to the same standard, and it is written once.

- **Same finding.** Two findings are the same when they share at least one item ID in `location.item_ids` and have the
  same kind. A re-review never reports a finding that is the same as a prior one.
- **Addressed.** A prior finding is addressed when the row it cites now states what the finding asked for. When the
  row is unchanged, the finding is still open: list its ID, do not write it again.
- **Severity.** Use the severity criteria of the review command as written. Do not raise a severity to make a
  finding look urgent, and do not lower one because a fix seems easy.
- **Verification.** A verifier judges a finding from the spec pages only: never from the reviewer's reasoning, its
  proposed answer or how confident it sounded. A finding the spec already answers elsewhere (a CMN rule, a reference
  to another item) is not a real problem.
