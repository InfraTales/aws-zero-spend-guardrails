# Contributing

Thanks for helping. This repo is a reference for keeping a new AWS account at $0 with AWS's own tools, so every change has to stay free to run and keep its tests honest.

## Setup

You need Node.js 24 and npm. The tests run without an AWS account.

```bash
npm ci
npm run check   # type check, lint, tests, synth with cdk-nag
```

## Layout

| Path | What's there |
|---|---|
| `infra/lib/zero-spend-guardrails-stack.ts` | The stack and its input checks |
| `infra/bin/app.ts` | Reads `-c` context values and creates the stack in us-east-1 |
| `src/free-tier-report.ts` | The report logic: paging, statuses, formatting, exit codes |
| `scripts/free-tier-report.ts` | The CLI entry point |
| `test/unit` | Report tests with aws-sdk-client-mock |
| `test/flow` | The real CLI against a local HTTP stand-in for the Free Tier API |
| `test/infra` | Template assertions and cdk-nag |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first. For a safeguard, break it once and check that a test fails.
- **No new cost.** If a change adds anything billable, say what it costs in `docs/cost.md` and why it's worth it.
- **Exact deny statements.** If you add an action to the spend-freeze policy, update the exact-statement test and the list in the README.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about. There are none today.
- **Docs updated** when behaviour changes.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.
