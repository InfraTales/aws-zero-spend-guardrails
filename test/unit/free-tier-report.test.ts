import {
  FreeTierClient,
  GetAccountPlanStateCommand,
  GetFreeTierUsageCommand,
  type FreeTierUsage,
} from '@aws-sdk/client-freetier';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { classify, fetchAllUsage, formatReport, main, sortRows } from '../../src/free-tier-report';

const ft = mockClient(FreeTierClient);
const client = new FreeTierClient({ region: 'us-east-1' });

const usage = (o: Partial<FreeTierUsage>): FreeTierUsage => ({
  service: 'AWS Lambda',
  usageType: 'Request',
  region: 'global',
  freeTierType: 'Always Free',
  unit: 'Requests',
  limit: 1_000_000,
  actualUsageAmount: 0,
  forecastedUsageAmount: 0,
  ...o,
});

function namedError(name: string, message = name): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

async function run(argv: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { client, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

beforeEach(() => {
  ft.reset();
  ft.on(GetAccountPlanStateCommand).resolves({
    accountId: '123456789012',
    accountPlanType: 'FREE',
    accountPlanStatus: 'ACTIVE',
    accountPlanRemainingCredits: { amount: 187.5, unit: 'USD' },
    accountPlanExpirationDate: new Date('2027-03-01T00:00:00Z'),
  });
});

describe('classify', () => {
  test('under 80% of the limit is OK', () => {
    expect(classify(usage({ actualUsageAmount: 799_999, forecastedUsageAmount: 900_000 })).status).toBe('OK');
  });

  test('exactly 80% of the limit is flagged', () => {
    const r = classify(usage({ actualUsageAmount: 800_000, forecastedUsageAmount: 900_000 }));
    expect(r.status).toBe('AT_80');
    expect(r.usedPct).toBeCloseTo(80);
  });

  test('a forecast over the limit is flagged even when actual use is low', () => {
    const r = classify(usage({ actualUsageAmount: 100_000, forecastedUsageAmount: 1_200_000 }));
    expect(r.status).toBe('FORECAST_OVER');
    expect(r.forecastPct).toBeCloseTo(120);
  });

  test('a forecast equal to the limit is not over it', () => {
    expect(classify(usage({ actualUsageAmount: 100, forecastedUsageAmount: 1_000_000 })).status).toBe('OK');
  });

  test('actual use at the limit is OVER, which beats every other status', () => {
    expect(classify(usage({ actualUsageAmount: 1_000_000, forecastedUsageAmount: 3_000_000 })).status).toBe('OVER');
  });

  test('a line without a limit is never flagged and has no percentages', () => {
    const r = classify(usage({ limit: undefined, actualUsageAmount: 5 }));
    expect(r.status).toBe('NO_LIMIT');
    expect(r.usedPct).toBeUndefined();
  });

  test('sortRows puts the worst first', () => {
    const rows = [
      classify(usage({ usageType: 'ok', actualUsageAmount: 10 })),
      classify(usage({ usageType: 'at80', actualUsageAmount: 850_000, forecastedUsageAmount: 950_000 })),
      classify(usage({ usageType: 'over', actualUsageAmount: 2_000_000 })),
      classify(usage({ usageType: 'forecast', actualUsageAmount: 10, forecastedUsageAmount: 2_000_000 })),
    ];
    expect(sortRows(rows).map((r) => r.usageType)).toEqual(['over', 'forecast', 'at80', 'ok']);
  });
});

describe('fetchAllUsage', () => {
  test('follows nextToken across pages and keeps every line', async () => {
    // The SDK paginator reuses one input object, so copy each request as it arrives.
    const seen: Record<string, unknown>[] = [];
    const pages = [
      { freeTierUsages: [usage({ usageType: 'a' }), usage({ usageType: 'b' })], nextToken: 't1' },
      { freeTierUsages: [usage({ usageType: 'c' })], nextToken: 't2' },
      { freeTierUsages: [usage({ usageType: 'd' })] },
    ];
    ft.on(GetFreeTierUsageCommand).callsFake((input: Record<string, unknown>) => {
      seen.push({ ...input });
      return pages[seen.length - 1];
    });
    const all = await fetchAllUsage(client);
    expect(all.map((u) => u.usageType)).toEqual(['a', 'b', 'c', 'd']);
    expect(seen).toEqual([{ maxResults: 1000 }, { maxResults: 1000, nextToken: 't1' }, { maxResults: 1000, nextToken: 't2' }]);
  });

  test('a page with no freeTierUsages field counts as empty', async () => {
    ft.on(GetFreeTierUsageCommand).resolves({ freeTierUsages: undefined });
    expect(await fetchAllUsage(client)).toEqual([]);
  });
});

describe('main', () => {
  test('prints the plan, the lines and a summary, worst first', async () => {
    ft.on(GetFreeTierUsageCommand).resolves({
      freeTierUsages: [
        usage({ service: 'AWS Lambda', usageType: 'Request', actualUsageAmount: 50_000, forecastedUsageAmount: 100_000 }),
        usage({ service: 'Amazon DynamoDB', usageType: 'TimedStorage-ByteHrs', unit: 'GB-Mo', limit: 25, actualUsageAmount: 21, forecastedUsageAmount: 24 }),
      ],
    });
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out).toContain('Account plan: FREE (ACTIVE), credits left 187.50 USD, plan expires 2027-03-01');
    const lines = out.split('\n');
    const dynamo = lines.findIndex((l) => l.includes('Amazon DynamoDB'));
    const lambda = lines.findIndex((l) => l.includes('AWS Lambda'));
    expect(dynamo).toBeLessThan(lambda);
    expect(lines[dynamo]).toMatch(/^AT_80\s+Amazon DynamoDB\s+TimedStorage-ByteHrs\s+21 GB-Mo\s+25 GB-Mo\s+84\.0%\s+96\.0%/);
    expect(out).toContain('1 of 2 lines need a look.');
  });

  test('empty results print a clear message, not an empty table', async () => {
    ft.on(GetFreeTierUsageCommand).resolves({ freeTierUsages: [] });
    const { code, out } = await run(['--strict']);
    expect(code).toBe(0);
    expect(out).toContain('No Free Tier usage reported this month.');
    expect(out).not.toContain('STATUS');
  });

  test('--strict exits 2 when a forecast goes over a limit', async () => {
    ft.on(GetFreeTierUsageCommand).resolves({ freeTierUsages: [usage({ actualUsageAmount: 300_000, forecastedUsageAmount: 1_500_000 })] });
    expect((await run()).code).toBe(0);
    const strict = await run(['--strict']);
    expect(strict.code).toBe(2);
    expect(strict.out).toMatch(/^FORECAST_OVER\s+AWS Lambda/m);
  });

  test('--strict exits 0 when nothing is flagged', async () => {
    ft.on(GetFreeTierUsageCommand).resolves({ freeTierUsages: [usage({ actualUsageAmount: 10, forecastedUsageAmount: 20 })] });
    const { code, out } = await run(['--strict']);
    expect(code).toBe(0);
    expect(out).toContain('All 1 lines are under 80% of their limit.');
  });

  test('an account with no plan state still gets the usage report', async () => {
    ft.on(GetAccountPlanStateCommand).rejects(namedError('ResourceNotFoundException'));
    ft.on(GetFreeTierUsageCommand).resolves({ freeTierUsages: [usage({ actualUsageAmount: 10 })] });
    const { code, out } = await run();
    expect(code).toBe(0);
    expect(out).toContain('Account plan: not shown (ResourceNotFoundException)');
    expect(out).toContain('AWS Lambda');
  });

  test('a throttled usage call fails the run with exit 1 and the error name', async () => {
    ft.on(GetFreeTierUsageCommand).rejects(namedError('ThrottlingException', 'Rate exceeded'));
    const { code, out, err } = await run();
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('free-tier-report: ThrottlingException: Rate exceeded');
  });

  test('access denied on usage says which permissions are missing', async () => {
    ft.on(GetFreeTierUsageCommand).rejects(namedError('AccessDeniedException', 'not authorized'));
    const { code, err } = await run();
    expect(code).toBe(1);
    expect(err).toContain('freetier:GetFreeTierUsage and freetier:GetAccountPlanState');
  });

  test('an unexpected plan error is not swallowed', async () => {
    ft.on(GetAccountPlanStateCommand).rejects(namedError('InternalServerException', 'boom'));
    ft.on(GetFreeTierUsageCommand).resolves({ freeTierUsages: [] });
    const { code, err } = await run();
    expect(code).toBe(1);
    expect(err).toContain('InternalServerException');
  });

  test('a failure on the second page fails the whole run', async () => {
    ft.on(GetFreeTierUsageCommand)
      .resolvesOnce({ freeTierUsages: [usage({})], nextToken: 't1' })
      .rejectsOnce(namedError('ValidationException', 'bad token'));
    const { code, err } = await run();
    expect(code).toBe(1);
    expect(err).toContain('ValidationException: bad token');
  });
});

test('formatReport shows non-integer amounts with two decimals', () => {
  const text = formatReport({ available: false, reason: 'AccessDeniedException' }, [
    classify(usage({ unit: 'GB', limit: 5, actualUsageAmount: 4.123456, forecastedUsageAmount: 4.5 })),
  ]);
  expect(text).toContain('4.12 GB');
  expect(text).toContain('82.5%');
});
