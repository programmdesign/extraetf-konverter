# Skill: `extraetf-import-ops`

A [Claude Code](https://claude.com/claude-code) skill that captures how to operate the **ExtraETF**
web app (app.extraetf.com) when fixing, testing or adjusting CapTrader → ExtraETF imports —
booking/deleting transactions, CSV imports, reconciling the Verrechnungskonto, and the known
ExtraETF import quirks (split-with-ISIN-change price glitch, foreign-currency dividend FX bug).

It exists so that browser-driven ExtraETF work is fast and low-risk: exact selectors, field IDs,
click sequences and gotchas are written down instead of rediscovered each time.

- **`SKILL.md`** — the skill itself (with frontmatter). Claude loads it automatically when a task
  matches the description (manual ExtraETF booking/fixing, converter work, import diagnosis).
- Nothing account-specific is stored here (depot IDs are generalised); it's safe in a public repo.

Not a runtime dependency of the converter — the converter (`captrader-to-extraetf.html`) works on its own.
