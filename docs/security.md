# Security

This stack changes IAM permissions in your account when spend crosses a line, so you should know what each part can do.

## The budget action's execution role

AWS Budgets assumes this role to attach the deny policy, and to detach it when you reverse the action.

- Only `budgets.amazonaws.com` can assume it, and only for budgets in this account (`aws:SourceAccount` plus `aws:SourceArn` of `arn:aws:budgets::<account>:budget/*`). That condition stops another account's budget from using your role.
- It can call `iam:AttachRolePolicy` and `iam:DetachRolePolicy` on the roles you named, and the group versions on the groups you named. Nothing else.
- Every statement carries `iam:PolicyARN` equal to the spend-freeze policy. The role can't attach `AdministratorAccess` to anyone, even to the roles you named.

The AWS docs' example policy for budget actions allows those calls on `*`, plus `organizations:AttachPolicy` and EC2 and RDS start and stop. This stack needs none of the extras, so it leaves them out.

## The spend-freeze policy

It's a customer managed policy with only `Deny` statements, so attaching it can take permissions away but can't grant one. It isn't attached to anything at deploy time.

Two statements protect the policy itself. The restricted role can't detach it (`iam:DetachRolePolicy` and `iam:DetachGroupPolicy` with `iam:PolicyARN` set to this policy), and it can't edit or delete it. To lift the freeze you reverse the action in AWS Budgets, and the action history records that.

This is a guardrail against mistakes, not against someone who wants to spend. An admin role can still delete the budget, the stack or the policy attachment through other paths, and IAM policies don't apply to the root user.

## The SNS topic

- The topic policy lets `budgets.amazonaws.com` publish only for budgets in this account, and `costalerts.amazonaws.com` publish only for this account.
- `enforceSSL` adds a statement that denies any publish not made over TLS.
- The topic has no KMS encryption. The SNS docs say AWS services that publish to an encrypted topic need a customer managed KMS key whose key policy names them. That key costs $1 a month, which is the one bill this repo is meant to prevent. The alerts carry spend amounts and service names, not customer data. If your account's policy requires encrypted topics, add a customer managed key with `kms:GenerateDataKey*` and `kms:Decrypt` for both service principals, as the Budgets and Cost Anomaly Detection docs show.

## The report script

It calls two read-only APIs: `freetier:GetAccountPlanState` and `freetier:GetFreeTierUsage`. A least-privilege policy for whoever runs it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["freetier:GetAccountPlanState", "freetier:GetFreeTierUsage"], "Resource": "*" }
  ]
}
```
