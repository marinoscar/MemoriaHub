# Architecture decision records

An architecture decision record (ADR) states one decision that shapes more than one feature, why it was made, what it costs, and what enforces it. Specs (`../specs/`) describe how a feature works; an ADR describes why the system is shaped the way it is. Links are relative to `docs/decisions/`.

## Format

Every ADR is a file `NNNN-<slug>.md` with these sections, in this order:

| Section | Content |
|---|---|
| Header lines | `Status`, `Date`, `Related issues` |
| Context | The forces and the question being decided |
| Decision | What is decided, stated as rules where they can be checked |
| Consequences | What gets easier, what gets harder, risks accepted |
| Alternatives considered | What was rejected and why |
| Enforcement | The tests, lint rules, checks or review items that keep the decision true |
| Related issues | Issues and pull requests |

## Numbering and status

- Numbers are four digits, assigned in order, and are append-only. Never renumber, rename or delete an ADR.
- Statuses: `Proposed`, `Accepted`, `Superseded by ADR-000N`, `Deprecated`.
- To change a decision, write a new ADR and set the old one to `Superseded by ADR-000N`. Leave the old text as it was; it is the record.
- Small corrections (a broken link, a typo) are allowed in place. A change of meaning is not.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-packages-first.md) | Packages first: domain code is written once, in a package, and mounted by every host | Accepted |
