# Product Manager — multi-unit-configurations

## Source facts (fetched 2026-10-14)

- Studio page: add-ons "Rooftop decks, Front decks, Integrated stair systems, Gazebos", "individually or combined".
  Custom/multi-unit: **Connected** (units connected "across different lengths"), **Double-Wide** (side by side "to create
  wider interiors"), **Stacked / Multi-Level** ("entirely new spaces across multiple levels"), **Custom**.
  Gallery: "Two-level studio configuration with exterior stairs" — gym below, office + rooftop deck above.
- Container page: 10′ roll-up (multiple sizes/colors), center / partial / full open-side, integrated exterior finish.
  No multi-unit wording, but Portable Units gallery shows "Container gym row with outdoor training area".
- Portable Units page: "Modular Configurations: Single, connected, and multi-level options." "Indoor + Outdoor:
  Interior space with deck, rooftop, and exterior options."
- No published prices for add-ons, multi-unit, or custom configurations.

## [DISCOVERED] Current state

- `studioLayout` select (single/connected/double-wide/multi-level/stacked/custom) is Studio-only and inquiry-only.
- Container family forbids all multi-unit and add-on choices in schema validation.
- First commit (5286ae5) had per-option prices and add-on dependencies; both removed in 229d5bf as unsourced.

## Requirements — to be defined in brainstorming
