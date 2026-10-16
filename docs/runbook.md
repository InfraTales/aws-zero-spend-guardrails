# Runbook

## You got a zero-spend alert

Something billed more than one cent this month, before credits. That's often fine, but find out what it is.

1. Run `npm run free-tier-report`. Any line marked `OVER` is past its free allowance.
2. Open Cost Explorer, group by Service, then by Usage type, for this month. Cost Explorer data can lag by up to 24 hours, so the charge may have started yesterday.
3. Look for anything that bills by the hour: NAT gateways, public IPv4 addresses, load balancers, running instances, databases.

## You got an anomaly alert

Open the `anomalyDetailsLink` in the message. It shows the service, Region and usage type behind the spike. Cost Anomaly Detection needs 10 days of history for a new service before it can flag that service, so a brand-new service may show up in the zero-spend budget first.

## The freeze fired

AWS Budgets attached `ZeroSpendGuardrails-spend-freeze` to your role or group. You'll see `AccessDenied` on launches and model calls, and `cdk deploy` fails too, because the role can no longer assume the CDK bootstrap roles or pass a role.

1. Find what's running and delete what you don't need. The freeze stops new resources, not running ones.
2. Once you're ready to work again, open AWS Budgets, choose the monthly budget, find the action in **Action history**, and reverse it. AWS Budgets then stops evaluating it for the rest of the month. Choose **Reset** if you want it watching again in the same month.
3. If the limit is too low for what you're building, raise `monthlyLimitUsd` and redeploy. Reverse the action first, or the deploy fails.

## No alerts ever arrive

- Check that you confirmed the SNS subscription. In the SNS console, a `PendingConfirmation` status means you didn't.
- Check the topic policy still has the `AllowBudgetsPublish` and `AllowCostAnomalyDetectionPublish` statements.
- Free Tier usage alerts (the 85% emails) go to the root user's email, not to this topic. Change that address under Billing preferences, Alert preferences.
