---
"llm-output-guard": minor
---

Initial release: deterministic detection of degenerate LLM output that arrives with a successful HTTP status.

Detectors for emptiness, shortness, n-gram repetition, tail loops, character-level entropy collapse, truncation, JSON validity, and language mismatch. Ships `checkOutput` (verdict) and `assertOutput` (throwing, for existing retry layers), four calibrated presets, and a fixture corpus with deliberate false-positive traps.
