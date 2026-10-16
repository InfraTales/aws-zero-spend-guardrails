import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface ZeroSpendGuardrailsProps extends cdk.StackProps {
  /** Where every alert ends up. SNS sends a confirmation email first. */
  readonly alertEmail: string;
  /** The monthly cost budget in USD. The budget action fires at actionThresholdPercent of it. */
  readonly monthlyLimitUsd: number;
  /** IAM role names (no path) that get the deny policy when the action fires. */
  readonly restrictRoleNames?: string[];
  /** IAM group names (no path) that get the deny policy when the action fires. */
  readonly restrictGroupNames?: string[];
  /** Percent of monthlyLimitUsd, on actual spend, that runs the budget action. Default 100. */
  readonly actionThresholdPercent?: number;
  /** Smallest anomaly, in USD of total impact, that sends an alert. Default 1. */
  readonly anomalyThresholdUsd?: number;
  /**
   * ARN of an AWS services anomaly monitor you already have. An account can hold only one,
   * and AWS creates one for many new Cost Explorer users. When set, the stack attaches its
   * subscription to that monitor instead of creating a second one.
   */
  readonly existingAnomalyMonitorArn?: string;
}

/**
 * API calls the deny policy blocks once spend crosses the threshold. Everything here starts
 * something that bills by the hour or by the call. Already-running resources keep running:
 * an IAM policy can stop new work, not running work.
 */
export const DENY_STATEMENTS = {
  DenyNewComputeAndDatabases: [
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
  DenyHourlyNetworkCharges: [
    'ec2:AllocateAddress',
    'ec2:CreateNatGateway',
    'ec2:CreateVpcEndpoint',
    'elasticloadbalancing:CreateLoadBalancer',
  ],
  DenyModelInvocation: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
} as const;

const IAM_NAME = /^[\w+=,.@-]{1,64}$/;

export class ZeroSpendGuardrailsStack extends cdk.Stack {
  public readonly topic: sns.Topic;
  public readonly denyPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: ZeroSpendGuardrailsProps) {
    super(scope, id, props);
    const cfg = validate(props);

    // One topic carries every alert. Budgets and Cost Anomaly Detection each publish as their
    // own service principal, so each needs its own statement in the topic policy.
    this.topic = new sns.Topic(this, 'Alerts', { displayName: 'AWS spend guardrails', enforceSSL: true });
    this.topic.addSubscription(new subs.EmailSubscription(cfg.alertEmail));
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBudgetsPublish',
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:${this.partition}:budgets::${this.account}:*` },
        },
      }),
    );
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCostAnomalyDetectionPublish',
        principals: [new iam.ServicePrincipal('costalerts.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    );
    // Budgets and Cost Anomaly Detection check that they can publish when you create the
    // budget or subscription, so the topic policy must exist first.
    const topicPolicy = this.topic.node.findChild('Policy');

    const snsSubscriber = { subscriptionType: 'SNS', address: this.topic.topicArn };
    // Credits are counted as negative cost by default, which hides spend that is burning
    // your Free Tier credits. Both budgets leave credits out so you see the gross amount.
    const costTypes: budgets.CfnBudget.CostTypesProperty = { includeCredit: false };

    const zeroSpend = new budgets.CfnBudget(this, 'ZeroSpendBudget', {
      budget: {
        budgetName: `${this.stackName}-zero-spend`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 1, unit: 'USD' },
        costTypes,
      },
      notificationsWithSubscribers: [
        {
          // 1% of $1 is one cent. The CloudFormation schema rejects a threshold below 0.1,
          // so an ABSOLUTE_VALUE of 0.01 fails validation; a percentage of $1 does not.
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 1,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [snsSubscriber],
        },
      ],
    });
    zeroSpend.node.addDependency(topicPolicy);

    const monthly = new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${this.stackName}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: cfg.monthlyLimitUsd, unit: 'USD' },
        costTypes,
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers: [snsSubscriber],
        },
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers: [snsSubscriber],
        },
      ],
    });
    monthly.node.addDependency(topicPolicy);

    // The deny policy has a fixed name so its own statements can refer to its ARN
    // without a circular reference.
    const denyPolicyName = `${this.stackName}-spend-freeze`;
    const denyPolicyArn = `arn:${this.partition}:iam::${this.account}:policy/${denyPolicyName}`;
    this.denyPolicy = new iam.ManagedPolicy(this, 'SpendFreezePolicy', {
      managedPolicyName: denyPolicyName,
      description: 'Attached by an AWS Budgets action when monthly spend crosses the limit.',
      statements: [
        ...Object.entries(DENY_STATEMENTS).map(
          ([sid, actions]) => new iam.PolicyStatement({ sid, effect: iam.Effect.DENY, actions: [...actions], resources: ['*'] }),
        ),
        // A frozen role could otherwise hand the work to a role the freeze doesn't cover.
        // `cdk deploy` does exactly that: it assumes the CDK bootstrap roles, and
        // CloudFormation then creates resources as the cfn-exec role.
        new iam.PolicyStatement({
          sid: 'DenyAssumingCdkBootstrapRoles',
          effect: iam.Effect.DENY,
          actions: ['sts:AssumeRole'],
          resources: [`arn:${this.partition}:iam::*:role/cdk-*`],
        }),
        // Passing a role is how a caller gives CloudFormation, Lambda, ECS and others a role
        // to act as, so the frozen role can't pass any.
        new iam.PolicyStatement({
          sid: 'DenyPassingRoles',
          effect: iam.Effect.DENY,
          actions: ['iam:PassRole'],
          resources: ['*'],
        }),
        // Without these, the restricted role could detach the freeze and carry on. Reversing
        // it goes through AWS Budgets instead, where the action history records it.
        new iam.PolicyStatement({
          sid: 'DenyDetachingThisPolicy',
          effect: iam.Effect.DENY,
          actions: ['iam:DetachGroupPolicy', 'iam:DetachRolePolicy'],
          resources: ['*'],
          conditions: { ArnEquals: { 'iam:PolicyARN': denyPolicyArn } },
        }),
        new iam.PolicyStatement({
          sid: 'DenyEditingThisPolicy',
          effect: iam.Effect.DENY,
          actions: ['iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'],
          resources: [denyPolicyArn],
        }),
      ],
    });

    // The role AWS Budgets assumes to attach (and later detach) the deny policy. It can attach
    // only that one policy, and only to the roles and groups you named.
    const roleArns = cfg.restrictRoleNames.map((n) => `arn:${this.partition}:iam::${this.account}:role/${n}`);
    const groupArns = cfg.restrictGroupNames.map((n) => `arn:${this.partition}:iam::${this.account}:group/${n}`);
    const executionRole = new iam.Role(this, 'BudgetActionRole', {
      description: 'Assumed by AWS Budgets to attach the spend-freeze policy.',
      assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:${this.partition}:budgets::${this.account}:budget/*` },
        },
      }),
    });
    const onlyThisPolicy = { ArnEquals: { 'iam:PolicyARN': this.denyPolicy.managedPolicyArn } };
    if (roleArns.length > 0) {
      executionRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'AttachFreezeToRoles',
          actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
          resources: roleArns,
          conditions: onlyThisPolicy,
        }),
      );
    }
    if (groupArns.length > 0) {
      executionRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'AttachFreezeToGroups',
          actions: ['iam:AttachGroupPolicy', 'iam:DetachGroupPolicy'],
          resources: groupArns,
          conditions: onlyThisPolicy,
        }),
      );
    }

    const action = new budgets.CfnBudgetsAction(this, 'SpendFreezeAction', {
      budgetName: monthly.ref,
      actionType: 'APPLY_IAM_POLICY',
      notificationType: 'ACTUAL',
      actionThreshold: { type: 'PERCENTAGE', value: cfg.actionThresholdPercent },
      approvalModel: 'AUTOMATIC',
      executionRoleArn: executionRole.roleArn,
      definition: {
        iamActionDefinition: {
          policyArn: this.denyPolicy.managedPolicyArn,
          roles: cfg.restrictRoleNames.length > 0 ? cfg.restrictRoleNames : undefined,
          groups: cfg.restrictGroupNames.length > 0 ? cfg.restrictGroupNames : undefined,
        },
      },
      subscribers: [{ type: 'SNS', address: this.topic.topicArn }],
    });
    // Create the role and its permissions before the action that uses them.
    action.node.addDependency(executionRole);
    action.node.addDependency(topicPolicy);

    let monitorArn = cfg.existingAnomalyMonitorArn;
    if (monitorArn === undefined) {
      const monitor = new ce.CfnAnomalyMonitor(this, 'ServiceMonitor', {
        monitorName: `${this.stackName}-services`,
        monitorType: 'DIMENSIONAL',
        monitorDimension: 'SERVICE',
      });
      monitorArn = monitor.attrMonitorArn;
    }
    const anomalySub = new ce.CfnAnomalySubscription(this, 'AnomalySubscription', {
      subscriptionName: `${this.stackName}-anomalies`,
      frequency: 'IMMEDIATE', // IMMEDIATE alerts go to SNS only; DAILY and WEEKLY are email only.
      monitorArnList: [monitorArn],
      subscribers: [{ type: 'SNS', address: this.topic.topicArn }],
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: [String(cfg.anomalyThresholdUsd)],
        },
      }),
    });
    anomalySub.node.addDependency(topicPolicy);

    new cdk.CfnOutput(this, 'AlertTopicArn', { value: this.topic.topicArn });
    new cdk.CfnOutput(this, 'SpendFreezePolicyArn', { value: this.denyPolicy.managedPolicyArn });
    new cdk.CfnOutput(this, 'AnomalyMonitorArn', { value: monitorArn });
  }
}

interface Config {
  alertEmail: string;
  monthlyLimitUsd: number;
  restrictRoleNames: string[];
  restrictGroupNames: string[];
  actionThresholdPercent: number;
  anomalyThresholdUsd: number;
  existingAnomalyMonitorArn?: string;
}

/** Fails synth with a clear message instead of letting CloudFormation fail halfway through a deploy. */
export function validate(props: ZeroSpendGuardrailsProps): Config {
  const fail = (msg: string): never => {
    throw new Error(`ZeroSpendGuardrails: ${msg}`);
  };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(props.alertEmail ?? '')) fail(`alertEmail is not an email address: ${JSON.stringify(props.alertEmail)}`);
  if (!Number.isFinite(props.monthlyLimitUsd) || props.monthlyLimitUsd <= 0) fail('monthlyLimitUsd must be a number above 0');
  const roles = props.restrictRoleNames ?? [];
  const groups = props.restrictGroupNames ?? [];
  if (roles.length + groups.length === 0) fail('name at least one role or group in restrictRoleNames or restrictGroupNames');
  for (const n of [...roles, ...groups]) if (!IAM_NAME.test(n)) fail(`not a plain IAM role or group name: ${JSON.stringify(n)}`);
  const pct = props.actionThresholdPercent ?? 100;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 1000) fail('actionThresholdPercent must be above 0 and at most 1000');
  const anomaly = props.anomalyThresholdUsd ?? 1;
  if (!Number.isFinite(anomaly) || anomaly < 0) fail('anomalyThresholdUsd must be 0 or more');
  const monitor = props.existingAnomalyMonitorArn;
  if (monitor !== undefined && !/^arn:aws[a-z-]*:ce::\d{12}:anomalymonitor\/[\w-]+$/.test(monitor)) {
    fail(`existingAnomalyMonitorArn is not an anomaly monitor ARN: ${JSON.stringify(monitor)}`);
  }
  return {
    alertEmail: props.alertEmail,
    monthlyLimitUsd: props.monthlyLimitUsd,
    restrictRoleNames: roles,
    restrictGroupNames: groups,
    actionThresholdPercent: pct,
    anomalyThresholdUsd: anomaly,
    existingAnomalyMonitorArn: monitor,
  };
}
