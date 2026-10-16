# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack limits itself

[docs/security.md](docs/security.md) has the details and the reasons.

- Only AWS Budgets, for budgets in this account, can assume the budget action's role.
- That role can attach one policy, the spend freeze, to the roles and groups you name. Nothing else.
- The spend-freeze policy has only Deny statements, and the restricted role can't detach or edit it.
- The SNS topic accepts publishes from Budgets and Cost Anomaly Detection for this account only, over TLS only.
- The report script uses two read-only Free Tier API calls.
