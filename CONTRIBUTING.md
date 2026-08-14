# Contributing

MosaicCompress is a small, opinionated library — Occam's razor applies.

## Principles

1. **Keep it small.** The library is under 500 lines for a reason. A change
   that doubles the code needs a proportionally strong justification.
2. **Benchmarks are the source of truth.** Any behavior change must keep
   `npm run bench` green and update the tables in README if numbers move.
3. **No over-engineering.** Theory goes in `docs/design.md`; code stays V1
   (raw / light / heavy). The multi-tier pyramid is documented, not built.
4. **Tests first.** Zero-LLM-cost tests using mock responses
   (`npm test`); every edge case in the suite must stay green.

## Workflow

```bash
npm install
npm test        # mock-LLM unit tests
npm run typecheck
npm run bench   # deterministic simulator sweep
```

Then open a PR. CI is minimal on purpose.
