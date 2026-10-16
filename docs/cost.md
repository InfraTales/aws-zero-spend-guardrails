# Cost

I checked every price below on 2026-10-16. Prices come from the AWS Price List API offer files for us-east-1, or from the AWS page named in the row.

| Part | Price | Used here | Monthly |
|---|---|---|---|
| AWS Budgets, monitoring | $0.00 per budget-day | 2 budgets | $0 |
| AWS Budgets, action-enabled budgets | First 62 budget-days free each month (two budgets for a 31-day month), then $0.10 per budget-day | 1 budget | $0 |
| Cost Anomaly Detection | No charge ("no effort or cost", AWS FAQ) | 1 monitor, 1 subscription | $0 |
| Amazon SNS email | First 1,000 email notifications free each month, then $2.00 per 100,000 | A handful of alerts | $0 |
| Amazon SNS API requests | First 1,000,000 free each month | A handful | $0 |
| IAM role and policy | No charge | 1 role, 2 policies | $0 |
| Free Tier API (report script) | "at no cost" (AWS Billing docs) | 2 calls per run | $0 |

## Things that would add cost

- **A third budget with an action.** If you already have two action-enabled budgets, this stack's one costs $0.10 a day, about $3.10 for a 31-day month.
- **A KMS key for the topic.** $1 per customer managed key per month. [security.md](security.md) explains why the topic doesn't use one.
- **Budget reports.** $0.01 each. This stack doesn't create any.
- **Cost Explorer API calls.** $0.01 per request. The report script doesn't call Cost Explorer; it uses the Free Tier API.

## The traps the guardrails watch for

These are the charges that surprise people on a new account:

| Item | Price | 30 days |
|---|---|---|
| Public IPv4 address, in use or idle | $0.005 per hour | $3.60 |
| NAT gateway (AWS's US East (Ohio) example) | $0.045 per hour, plus $0.045 per GB processed | $32.40 before data |

The deny policy blocks creating new ones. It can't remove one you already have.
