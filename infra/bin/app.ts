#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ZeroSpendGuardrailsStack } from '../lib/zero-spend-guardrails-stack';

const app = new cdk.App();

// Settings come from context, for example:
//   npx cdk deploy -c alertEmail=you@example.com -c monthlyLimitUsd=5 -c restrictRoles=Developer
const ctx = (key: string): string | undefined => {
  const v: unknown = app.node.tryGetContext(key);
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new Error(`Context value ${key} must be a string, got ${JSON.stringify(v)}`);
};
const list = (key: string): string[] =>
  (ctx(key) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
const num = (key: string): number | undefined => (ctx(key) === undefined ? undefined : Number(ctx(key)));

new ZeroSpendGuardrailsStack(app, 'ZeroSpendGuardrails', {
  alertEmail: ctx('alertEmail') ?? '',
  monthlyLimitUsd: num('monthlyLimitUsd') ?? 5,
  restrictRoleNames: list('restrictRoles'),
  restrictGroupNames: list('restrictGroups'),
  actionThresholdPercent: num('actionThresholdPercent'),
  anomalyThresholdUsd: num('anomalyThresholdUsd'),
  existingAnomalyMonitorArn: ctx('anomalyMonitorArn'),
  // The Budgets, Cost Explorer and Free Tier APIs all live in us-east-1.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
});

// Fail synth on any AWS Solutions finding that isn't acknowledged with a reason.
cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
