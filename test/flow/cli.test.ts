import { spawn } from 'child_process';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

// Runs the real CLI as its own process, with the real AWS SDK, against a local stand-in for the
// Free Tier API (AWS_ENDPOINT_URL_FREETIER). This checks the parts the unit tests mock away:
// request signing and routing, JSON (de)serialization, and the exit code the shell sees.

type Handler = (target: string, body: Record<string, unknown>) => { status: number; json: unknown };

async function withServer<T>(handler: Handler, fn: (url: string, calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const target = String(req.headers['x-amz-target'] ?? '');
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      calls.push(`${target} ${JSON.stringify(body)}`);
      const { status, json } = handler(target, body);
      res.writeHead(status, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls);
  } finally {
    server.close();
  }
}

function runCli(endpoint: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const root = path.join(__dirname, '../..');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'scripts/free-tier-report.ts', ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        AWS_ENDPOINT_URL_FREETIER: endpoint,
        AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'test-secret-not-real',
        AWS_MAX_ATTEMPTS: '1',
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    // A hung process must fail the test, not freeze CI.
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit in 30 s. stdout: ${out} stderr: ${err}`));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(deadline);
      resolve({ code, out, err });
    });
  });
}

const line = (o: Record<string, unknown>) => ({
  service: 'AWS Lambda',
  usageType: 'Request',
  region: 'global',
  freeTierType: 'Always Free',
  unit: 'Requests',
  limit: 1000000,
  actualUsageAmount: 10,
  forecastedUsageAmount: 20,
  ...o,
});

test('reads two pages over HTTP and exits 2 under --strict when a forecast is over', async () => {
  await withServer(
    (target, body) => {
      if (target.endsWith('.GetAccountPlanState')) {
        return { status: 200, json: { accountId: '123456789012', accountPlanType: 'PAID', accountPlanStatus: 'ACTIVE' } };
      }
      if (body.nextToken === undefined) return { status: 200, json: { freeTierUsages: [line({})], nextToken: 'page2' } };
      return { status: 200, json: { freeTierUsages: [line({ usageType: 'Lambda-GB-Second', forecastedUsageAmount: 2000000 })] } };
    },
    async (url, calls) => {
      const { code, out, err } = await runCli(url, ['--strict']);
      expect(err).toBe('');
      expect(code).toBe(2);
      expect(out).toContain('Account plan: PAID (ACTIVE)');
      expect(out).toMatch(/^FORECAST_OVER\s+AWS Lambda\s+Lambda-GB-Second/m);
      expect(out).toContain('1 of 2 lines need a look.');
      expect(calls.filter((c) => c.includes('GetFreeTierUsage'))).toHaveLength(2);
      expect(calls.some((c) => c.includes('"nextToken":"page2"'))).toBe(true);
    },
  );
}, 60_000);

test('an API error reaches the shell as exit 1 with the error name', async () => {
  await withServer(
    () => ({ status: 400, json: { __type: 'ThrottlingException', message: 'Rate exceeded' } }),
    async (url) => {
      const { code, out, err } = await runCli(url, []);
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('ThrottlingException');
    },
  );
}, 60_000);
