import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DENY_STATEMENTS, ZeroSpendGuardrailsProps, ZeroSpendGuardrailsStack } from '../../infra/lib/zero-spend-guardrails-stack';

const env = { account: '123456789012', region: 'us-east-1' };
// Use the same feature flags as `cdk synth`, including CloudFormation schema validation.
const context = JSON.parse(fs.readFileSync(path.join(__dirname, '../../cdk.json'), 'utf8')).context;
const newApp = (outdir?: string) => new cdk.App({ context, ...(outdir ? { outdir } : {}) });
const base: ZeroSpendGuardrailsProps = {
  env,
  alertEmail: 'ops@example.com',
  monthlyLimitUsd: 5,
  restrictRoleNames: ['Developer'],
  restrictGroupNames: ['Builders'],
};
const build = (over: Partial<ZeroSpendGuardrailsProps> = {}) =>
  Template.fromStack(new ZeroSpendGuardrailsStack(newApp(), 'Guard', { ...base, ...over }));
const template = build();

const one = (t: Template, type: string): [string, any] => {
  const all = Object.entries<any>(t.findResources(type));
  expect(all).toHaveLength(1);
  return all[0]!;
};
const budgetNamed = (t: Template, suffix: string) =>
  Object.values<any>(t.findResources('AWS::Budgets::Budget')).find((b) => b.Properties.Budget.BudgetName === `Guard-${suffix}`);

const topicLogicalId = one(template, 'AWS::SNS::Topic')[0];
const topicRef = { Ref: topicLogicalId };
const policyLogicalId = one(template, 'AWS::SNS::TopicPolicy')[0];
// With the recommended flags, CDK writes the partition as a literal for a known Region.
const arn = (rest: string) => `arn:aws${rest}`;
const denyPolicyArn = arn(':iam::123456789012:policy/Guard-spend-freeze');

describe('SNS topic', () => {
  test('lets Budgets publish, only for budgets in this account', () => {
    const [, policy] = one(template, 'AWS::SNS::TopicPolicy');
    expect(policy.Properties.PolicyDocument.Statement).toContainEqual({
      Sid: 'AllowBudgetsPublish',
      Effect: 'Allow',
      Principal: { Service: 'budgets.amazonaws.com' },
      Action: 'sns:Publish',
      Resource: topicRef,
      Condition: {
        StringEquals: { 'aws:SourceAccount': '123456789012' },
        ArnLike: { 'aws:SourceArn': arn(':budgets::123456789012:*') },
      },
    });
  });

  test('lets Cost Anomaly Detection publish, only for this account', () => {
    const [, policy] = one(template, 'AWS::SNS::TopicPolicy');
    expect(policy.Properties.PolicyDocument.Statement).toContainEqual({
      Sid: 'AllowCostAnomalyDetectionPublish',
      Effect: 'Allow',
      Principal: { Service: 'costalerts.amazonaws.com' },
      Action: 'sns:Publish',
      Resource: topicRef,
      Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
    });
  });

  test('refuses publishes that are not over TLS', () => {
    const [, policy] = one(template, 'AWS::SNS::TopicPolicy');
    expect(policy.Properties.PolicyDocument.Statement).toContainEqual(
      expect.objectContaining({ Effect: 'Deny', Action: 'sns:Publish', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
    );
  });

  test('is not KMS encrypted, because the services would need a paid customer managed key', () => {
    expect(one(template, 'AWS::SNS::Topic')[1].Properties.KmsMasterKeyId).toBeUndefined();
  });

  test('emails the alert address', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com', TopicArn: topicRef });
  });

  test('every publisher waits for the topic policy, or creation fails on a missing permission', () => {
    for (const type of ['AWS::Budgets::Budget', 'AWS::Budgets::BudgetsAction', 'AWS::CE::AnomalySubscription']) {
      for (const res of Object.values<any>(template.findResources(type))) expect(res.DependsOn).toContain(policyLogicalId);
    }
  });
});

describe('budgets', () => {
  test('zero-spend budget alerts at one cent of actual spend, credits left out', () => {
    const b = budgetNamed(template, 'zero-spend');
    expect(b.Properties.Budget).toMatchObject({
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: 1, Unit: 'USD' },
      CostTypes: { IncludeCredit: false },
    });
    expect(b.Properties.NotificationsWithSubscribers).toEqual([
      {
        Notification: { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 1, ThresholdType: 'PERCENTAGE' },
        Subscribers: [{ SubscriptionType: 'SNS', Address: topicRef }],
      },
    ]);
  });

  test('monthly budget alerts at 80% actual and 100% forecast, credits left out', () => {
    const b = budgetNamed(template, 'monthly');
    expect(b.Properties.Budget).toMatchObject({ BudgetLimit: { Amount: 5, Unit: 'USD' }, CostTypes: { IncludeCredit: false } });
    expect(b.Properties.NotificationsWithSubscribers.map((n: any) => n.Notification)).toEqual([
      { NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN', Threshold: 80, ThresholdType: 'PERCENTAGE' },
      { NotificationType: 'FORECASTED', ComparisonOperator: 'GREATER_THAN', Threshold: 100, ThresholdType: 'PERCENTAGE' },
    ]);
  });

  test('every notification threshold passes the CloudFormation minimum of 0.1', () => {
    for (const b of Object.values<any>(template.findResources('AWS::Budgets::Budget'))) {
      for (const n of b.Properties.NotificationsWithSubscribers) expect(n.Notification.Threshold).toBeGreaterThanOrEqual(0.1);
    }
  });
});

describe('budget action', () => {
  test('exists exactly once', () => {
    template.resourceCountIs('AWS::Budgets::BudgetsAction', 1);
  });

  const action = Object.values<any>(template.findResources('AWS::Budgets::BudgetsAction'))[0] ?? { Properties: {} };
  const monthlyLogicalId = Object.entries<any>(template.findResources('AWS::Budgets::Budget')).find(
    ([, b]) => b.Properties.Budget.BudgetName === 'Guard-monthly',
  )![0];
  const policyLogicalIdDeny = one(template, 'AWS::IAM::ManagedPolicy')[0];
  const roleLogicalId = one(template, 'AWS::IAM::Role')[0];

  test('attaches the deny policy to the named role and group when actual spend reaches 100%', () => {
    expect(action.Properties).toEqual({
      BudgetName: { Ref: monthlyLogicalId },
      ActionType: 'APPLY_IAM_POLICY',
      NotificationType: 'ACTUAL',
      ActionThreshold: { Type: 'PERCENTAGE', Value: 100 },
      ApprovalModel: 'AUTOMATIC',
      ExecutionRoleArn: { 'Fn::GetAtt': [roleLogicalId, 'Arn'] },
      Definition: { IamActionDefinition: { PolicyArn: { Ref: policyLogicalIdDeny }, Roles: ['Developer'], Groups: ['Builders'] } },
      Subscribers: [{ Type: 'SNS', Address: topicRef }],
    });
  });

  test('the threshold follows actionThresholdPercent', () => {
    const t = build({ actionThresholdPercent: 90 });
    expect(one(t, 'AWS::Budgets::BudgetsAction')[1].Properties.ActionThreshold).toEqual({ Type: 'PERCENTAGE', Value: 90 });
  });

  test('a role-only setup leaves Groups out instead of sending an empty list', () => {
    const t = build({ restrictGroupNames: [] });
    expect(one(t, 'AWS::Budgets::BudgetsAction')[1].Properties.Definition.IamActionDefinition).toEqual({
      PolicyArn: expect.anything(),
      Roles: ['Developer'],
    });
  });

  test('only AWS Budgets, for budgets in this account, can assume the execution role', () => {
    const [, role] = one(template, 'AWS::IAM::Role');
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      {
        Effect: 'Allow',
        Principal: { Service: 'budgets.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: { 'aws:SourceAccount': '123456789012' },
          ArnLike: { 'aws:SourceArn': arn(':budgets::123456789012:budget/*') },
        },
      },
    ]);
  });

  test('the execution role can attach only the deny policy, only to the named role and group', () => {
    const policies = Object.values<any>(template.findResources('AWS::IAM::Policy'));
    expect(policies).toHaveLength(1);
    const onlyDeny = { ArnEquals: { 'iam:PolicyARN': { Ref: policyLogicalIdDeny } } };
    expect(policies[0].Properties.PolicyDocument.Statement).toEqual([
      {
        Sid: 'AttachFreezeToRoles',
        Effect: 'Allow',
        Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        Resource: arn(':iam::123456789012:role/Developer'),
        Condition: onlyDeny,
      },
      {
        Sid: 'AttachFreezeToGroups',
        Effect: 'Allow',
        Action: ['iam:AttachGroupPolicy', 'iam:DetachGroupPolicy'],
        Resource: arn(':iam::123456789012:group/Builders'),
        Condition: onlyDeny,
      },
    ]);
  });
});

describe('deny policy', () => {
  const [, policy] = one(template, 'AWS::IAM::ManagedPolicy');

  test('has exactly these statements', () => {
    expect(policy.Properties.ManagedPolicyName).toBe('Guard-spend-freeze');
    expect(policy.Properties.PolicyDocument.Statement).toEqual([
      {
        Sid: 'DenyNewComputeAndDatabases',
        Effect: 'Deny',
        Action: [
          'ec2:RunInstances',
          'ec2:StartInstances',
          'ecs:CreateService',
          'ecs:RunTask',
          'eks:CreateCluster',
          'eks:CreateNodegroup',
          'lightsail:CreateInstances',
          'rds:CreateDBCluster',
          'rds:CreateDBInstance',
          'rds:StartDBCluster',
          'rds:StartDBInstance',
          'sagemaker:CreateEndpoint',
          'sagemaker:CreateNotebookInstance',
          'sagemaker:CreateTrainingJob',
        ],
        Resource: '*',
      },
      {
        Sid: 'DenyHourlyNetworkCharges',
        Effect: 'Deny',
        Action: ['ec2:AllocateAddress', 'ec2:CreateNatGateway', 'ec2:CreateVpcEndpoint', 'elasticloadbalancing:CreateLoadBalancer'],
        Resource: '*',
      },
      {
        Sid: 'DenyModelInvocation',
        Effect: 'Deny',
        Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        Resource: '*',
      },
      {
        Sid: 'DenyAssumingCdkBootstrapRoles',
        Effect: 'Deny',
        Action: 'sts:AssumeRole',
        Resource: 'arn:aws:iam::*:role/cdk-*',
      },
      {
        Sid: 'DenyPassingRoles',
        Effect: 'Deny',
        Action: 'iam:PassRole',
        Resource: '*',
      },
      {
        Sid: 'DenyDetachingThisPolicy',
        Effect: 'Deny',
        Action: ['iam:DetachGroupPolicy', 'iam:DetachRolePolicy'],
        Resource: '*',
        Condition: { ArnEquals: { 'iam:PolicyARN': denyPolicyArn } },
      },
      {
        Sid: 'DenyEditingThisPolicy',
        Effect: 'Deny',
        Action: ['iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'],
        Resource: denyPolicyArn,
      },
    ]);
  });

  test('blocks the routes around the freeze: CDK bootstrap roles and passing a role', () => {
    const stmts = policy.Properties.PolicyDocument.Statement;
    const bySid = (sid: string) => stmts.find((s: any) => s.Sid === sid);
    // cdk deploy assumes cdk-<qualifier>-deploy-role-* and passes cdk-<qualifier>-cfn-exec-role-*.
    expect(bySid('DenyAssumingCdkBootstrapRoles')).toMatchObject({ Effect: 'Deny', Action: 'sts:AssumeRole' });
    expect(bySid('DenyAssumingCdkBootstrapRoles').Resource).toBe('arn:aws:iam::*:role/cdk-*');
    expect(bySid('DenyAssumingCdkBootstrapRoles').Condition).toBeUndefined();
    expect(bySid('DenyPassingRoles')).toEqual({ Sid: 'DenyPassingRoles', Effect: 'Deny', Action: 'iam:PassRole', Resource: '*' });
  });

  test('allows nothing', () => {
    for (const s of policy.Properties.PolicyDocument.Statement) expect(s.Effect).toBe('Deny');
  });

  test('the exported action list and the template agree', () => {
    const fromTemplate = Object.fromEntries(policy.Properties.PolicyDocument.Statement.slice(0, 3).map((s: any) => [s.Sid, s.Action]));
    expect(fromTemplate).toEqual(DENY_STATEMENTS);
  });

  test('is not attached to anything at deploy time; only the budget action attaches it', () => {
    expect(policy.Properties.Roles).toBeUndefined();
    expect(policy.Properties.Groups).toBeUndefined();
    expect(policy.Properties.Users).toBeUndefined();
  });
});

describe('Cost Anomaly Detection', () => {
  test('creates an AWS services monitor and an immediate SNS subscription at $1', () => {
    const [monitorId] = one(template, 'AWS::CE::AnomalyMonitor');
    template.hasResourceProperties('AWS::CE::AnomalyMonitor', { MonitorType: 'DIMENSIONAL', MonitorDimension: 'SERVICE' });
    const [, sub] = one(template, 'AWS::CE::AnomalySubscription');
    expect(sub.Properties).toMatchObject({
      Frequency: 'IMMEDIATE',
      MonitorArnList: [{ 'Fn::GetAtt': [monitorId, 'MonitorArn'] }],
      Subscribers: [{ Type: 'SNS', Address: topicRef }],
    });
    expect(JSON.parse(sub.Properties.ThresholdExpression)).toEqual({
      Dimensions: { Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE', MatchOptions: ['GREATER_THAN_OR_EQUAL'], Values: ['1'] },
    });
  });

  test('reuses an existing monitor instead of creating a second one', () => {
    const arn = 'arn:aws:ce::123456789012:anomalymonitor/abcdef12-1234-4ea0-84cc-918a97d736ef';
    const t = build({ existingAnomalyMonitorArn: arn, anomalyThresholdUsd: 3 });
    t.resourceCountIs('AWS::CE::AnomalyMonitor', 0);
    const [, sub] = one(t, 'AWS::CE::AnomalySubscription');
    expect(sub.Properties.MonitorArnList).toEqual([arn]);
    expect(JSON.parse(sub.Properties.ThresholdExpression).Dimensions.Values).toEqual(['3']);
  });
});

describe('input checks fail synth with a clear message', () => {
  test.each<[string, Partial<ZeroSpendGuardrailsProps>, RegExp]>([
    ['bad email', { alertEmail: 'nope' }, /alertEmail/],
    ['zero limit', { monthlyLimitUsd: 0 }, /monthlyLimitUsd/],
    ['NaN limit', { monthlyLimitUsd: Number.NaN }, /monthlyLimitUsd/],
    ['nobody to restrict', { restrictRoleNames: [], restrictGroupNames: [] }, /at least one role or group/],
    ['role with a path', { restrictRoleNames: ['team/Dev'] }, /plain IAM role or group name/],
    ['threshold 0', { actionThresholdPercent: 0 }, /actionThresholdPercent/],
    ['negative anomaly threshold', { anomalyThresholdUsd: -1 }, /anomalyThresholdUsd/],
    ['wrong monitor ARN', { existingAnomalyMonitorArn: 'arn:aws:sns:us-east-1:123456789012:x' }, /existingAnomalyMonitorArn/],
  ])('%s', (_name, over, msg) => {
    expect(() => build(over)).toThrow(msg);
  });
});

describe('cdk-nag', () => {
  const synthWithNag = (extra?: (stack: cdk.Stack) => void) => {
    const app = newApp(fs.mkdtempSync(path.join(os.tmpdir(), 'cdk-nag-')));
    const stack = new ZeroSpendGuardrailsStack(app, 'Nag', base);
    extra?.(stack);
    cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app));
    return () => app.synth();
  };

  test('schema validation is on, so a budget threshold under 0.1 would fail synth', () => {
    expect(context['@aws-cdk/core:validateAgainstDefaultRules']).toBe(true);
  });

  test('AWS Solutions and CloudFormation schema checks find nothing, with no acknowledgements', () => {
    expect(synthWithNag()).not.toThrow();
  });

  test('the check is live: a topic without enforceSSL fails synth', () => {
    expect(synthWithNag((s) => new sns.Topic(s, 'Plain'))).toThrow(/AwsSolutions-SNS3/);
  });
});

test('outputs the topic, the deny policy and the monitor', () => {
  for (const name of ['AlertTopicArn', 'SpendFreezePolicyArn', 'AnomalyMonitorArn']) template.hasOutput(name, Match.anyValue());
});
