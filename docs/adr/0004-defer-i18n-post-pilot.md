# ADR 0004 — Defer i18n until post-pilot

**Status:** accepted
**Date:** 2026-05-18
**Supersedes:** —
**Superseded by:** —

## Context

The web client (`apps/web/src/`) ships English-only strings inlined in JSX. There is no `t()` shim, no i18n framework, no string-extraction tooling, and no translation pipeline. A recent audit counted ~553 user-visible string sites across `.tsx` files under `apps/web/src/`.

The temptation during pilot prep was to wrap every visible string in a `t('...')` shim now so that "switching on i18n later is one line." That framing is wrong: a `t()` shim that doesn't translate anything is not i18n readiness — it's a no-op layer that must be maintained, reviewed, and tested forever, in exchange for zero user-visible benefit.

Sitelayer's pilot is single-region (Ontario / English). There is no customer commitment for French, Spanish, or any other locale. No regulatory or contractual requirement forces localization in MVP scope.

## Decision

**Ship English-only. Do not add a `t()` shim, an i18n framework, or string-extraction tooling at this time.**

Concretely:

1. No new dependency on `react-i18next`, `i18next`, `@formatjs/*`, `lingui`, or equivalents.
2. No `t('...')` wrapping of literal strings in `.tsx` files.
3. No `locale` field added to user/company schemas.
4. Date / number / currency formatting continues to use `Intl.*` directly with hard-coded `'en-CA'` where regional formatting matters.

## Why now (vs. proactive shim)

Localization is a product commitment, not a refactoring task. Wrapping strings without translating them creates two persistent costs with no benefit:

- **Maintenance:** every new string review requires "did you wrap it?" enforcement (lint rule, PR review, agent prompt drift). The cost is real even when no translation exists.
- **Illusion of readiness:** stakeholders assume "we have i18n" when the only thing shipped is a passthrough function. Switching languages still requires a translation pipeline, locale switcher, RTL audit, and per-screen QA — none of which is delivered by a shim.

The actual blocker to multi-locale support is committing to translate, not refactoring string sites. Modern extraction tools (i18next-cli, lingui's `extract`) work against raw JSX literals, so the migration from "no shim" to "shim + translations" is mechanical when the commitment exists.

## Trigger to revisit

Revisit this ADR when **any** of the following becomes true:

- Multi-region expansion is committed (Canada Francophone, Mexico, EU).
- A pilot customer requires French-language UI for crew acceptance.
- Regulatory requirement (e.g. Quebec Bill 96 if a Quebec customer onboards).

## Recommendation when triggered

- **Framework:** `react-i18next` paired with `i18next-cli` for auto-extraction from JSX.
- **Storage:** JSON resource files under `apps/web/src/locales/<locale>/<namespace>.json`, one namespace per top-level screen folder.
- **Locale source:** `company_memberships.locale` (new column) overriding browser locale.
- **Migration approach:** extract-and-translate per screen, not all-at-once. Start with the highest-traffic mobile screens (`screens/mobile/`).
- **Number/date/currency:** keep `Intl.*` calls but pass the resolved locale instead of `'en-CA'`.

## Consequences

Positive:

- Zero ongoing maintenance cost for an unused abstraction.
- New strings can be reviewed for clarity, not for "did you wrap it correctly."
- No risk of partially-translated UI shipping accidentally.

Negative:

- When the trigger fires, ~553 string sites need to be wrapped before any translation can ship. That is the cost we are deferring.
- Agents and contributors must resist the "just add `t()` defensively" reflex — the cost is real even when each individual case feels cheap.

## Files in scope

Every `.tsx` file under `apps/web/src/`. The audit count (~553 sites) is approximate and will drift; the decision applies regardless of exact count.
