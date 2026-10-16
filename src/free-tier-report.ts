import {
  FreeTierClient,
  GetAccountPlanStateCommand,
  paginateGetFreeTierUsage,
  type FreeTierUsage,
  type GetAccountPlanStateCommandOutput,
} from '@aws-sdk/client-freetier';

/** Flag a Free Tier line once actual usage reaches this share of its limit. */
export const WARN_RATIO = 0.8;

export type Status = 'OVER' | 'FORECAST_OVER' | 'AT_80' | 'OK' | 'NO_LIMIT';

const SEVERITY: Record<Status, number> = { OVER: 0, FORECAST_OVER: 1, AT_80: 2, OK: 3, NO_LIMIT: 4 };

export interface Row {
  service: string;
  usageType: string;
  region: string;
  freeTierType: string;
  unit: string;
  limit: number;
  actual: number;
  forecast: number;
  usedPct: number | undefined;
  forecastPct: number | undefined;
  status: Status;
}

export type PlanInfo =
  | { available: true; type: string; status: string; creditsLeft?: string; expires?: string }
  | { available: false; reason: string };

/** Reads every page. The API returns at most 1,000 lines per call. */
export async function fetchAllUsage(client: FreeTierClient): Promise<FreeTierUsage[]> {
  const all: FreeTierUsage[] = [];
  for await (const page of paginateGetFreeTierUsage({ client, pageSize: 1000 }, {})) {
    all.push(...(page.freeTierUsages ?? []));
  }
  return all;
}

// Errors that mean "this account has no plan to show", not "the report failed".
const PLAN_NOT_APPLICABLE = new Set(['AccessDeniedException', 'ResourceNotFoundException']);

/** The Free plan or Paid plan, credits and expiry. Older accounts may have none of this. */
export async function fetchPlan(client: FreeTierClient): Promise<PlanInfo> {
  let out: GetAccountPlanStateCommandOutput;
  try {
    out = await client.send(new GetAccountPlanStateCommand({}));
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (PLAN_NOT_APPLICABLE.has(name)) return { available: false, reason: name };
    throw e;
  }
  const credits = out.accountPlanRemainingCredits;
  return {
    available: true,
    type: out.accountPlanType ?? 'UNKNOWN',
    status: out.accountPlanStatus ?? 'UNKNOWN',
    creditsLeft: credits?.amount === undefined ? undefined : `${credits.amount.toFixed(2)} ${credits.unit ?? ''}`.trim(),
    expires: out.accountPlanExpirationDate === undefined ? undefined : toDate(out.accountPlanExpirationDate),
  };
}

function toDate(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

export function classify(u: FreeTierUsage, warnRatio = WARN_RATIO): Row {
  const limit = u.limit ?? 0;
  const actual = u.actualUsageAmount ?? 0;
  const forecast = u.forecastedUsageAmount ?? 0;
  const hasLimit = limit > 0;
  let status: Status;
  if (!hasLimit) status = 'NO_LIMIT';
  else if (actual >= limit) status = 'OVER';
  else if (forecast > limit) status = 'FORECAST_OVER';
  else if (actual >= limit * warnRatio) status = 'AT_80';
  else status = 'OK';
  return {
    service: u.service ?? '?',
    usageType: u.usageType ?? '?',
    region: u.region ?? '',
    freeTierType: u.freeTierType ?? '',
    unit: u.unit ?? '',
    limit,
    actual,
    forecast,
    usedPct: hasLimit ? (actual / limit) * 100 : undefined,
    forecastPct: hasLimit ? (forecast / limit) * 100 : undefined,
    status,
  };
}

/** Worst first, then by how much of the limit is used. */
export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || (b.usedPct ?? -1) - (a.usedPct ?? -1));
}

export const isFlagged = (r: Row): boolean => r.status === 'OVER' || r.status === 'FORECAST_OVER' || r.status === 'AT_80';

const pct = (v: number | undefined): string => (v === undefined ? '-' : `${v.toFixed(1)}%`);
const amount = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function formatReport(plan: PlanInfo, rows: Row[]): string {
  const lines: string[] = [];
  if (plan.available) {
    const extra = [plan.creditsLeft && `credits left ${plan.creditsLeft}`, plan.expires && `plan expires ${plan.expires}`].filter(Boolean);
    lines.push(`Account plan: ${plan.type} (${plan.status})${extra.length ? `, ${extra.join(', ')}` : ''}`);
  } else {
    lines.push(`Account plan: not shown (${plan.reason})`);
  }
  if (rows.length === 0) {
    lines.push('No Free Tier usage reported this month.');
    return lines.join('\n');
  }
  const header = ['STATUS', 'SERVICE', 'USAGE TYPE', 'USED', 'LIMIT', 'USED %', 'FORECAST %', 'OFFER'];
  const body = sortRows(rows).map((r) => [
    r.status,
    r.service,
    r.usageType,
    `${amount(r.actual)} ${r.unit}`.trim(),
    `${amount(r.limit)} ${r.unit}`.trim(),
    pct(r.usedPct),
    pct(r.forecastPct),
    r.freeTierType,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  for (const row of [header, ...body]) lines.push(row.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd());
  const flagged = rows.filter(isFlagged).length;
  lines.push('');
  lines.push(flagged === 0 ? `All ${rows.length} lines are under 80% of their limit.` : `${flagged} of ${rows.length} lines need a look.`);
  return lines.join('\n');
}

export interface Deps {
  client: FreeTierClient;
  out: (s: string) => void;
  err: (s: string) => void;
}

/**
 * Exit codes: 0 report printed, 1 the API call failed, 2 something is flagged and --strict was set
 * (handy in a scheduled job).
 */
export async function main(argv: string[], deps: Deps): Promise<number> {
  const strict = argv.includes('--strict');
  try {
    const [plan, usage] = await Promise.all([fetchPlan(deps.client), fetchAllUsage(deps.client)]);
    const rows = usage.map((u) => classify(u));
    deps.out(formatReport(plan, rows));
    return strict && rows.some(isFlagged) ? 2 : 0;
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    const msg = e instanceof Error ? e.message : String(e);
    deps.err(`free-tier-report: ${name}: ${msg}`);
    if (name === 'AccessDeniedException') deps.err('The caller needs freetier:GetFreeTierUsage and freetier:GetAccountPlanState.');
    return 1;
  }
}
