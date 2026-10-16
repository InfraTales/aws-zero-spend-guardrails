// Read-only: prints this month's Free Tier usage against each limit and flags anything at 80% or more.
//   npm run free-tier-report            # always exits 0 when the report prints
//   npm run free-tier-report -- --strict # exits 2 when anything is flagged
import { FreeTierClient } from '@aws-sdk/client-freetier';
import { main } from '../src/free-tier-report';

// The Free Tier API has one endpoint, in us-east-1, whatever Region your profile uses.
const client = new FreeTierClient({ region: 'us-east-1' });

void main(process.argv.slice(2), {
  client,
  out: (s) => console.log(s),
  err: (s) => console.error(s),
}).then((code) => {
  process.exitCode = code;
});
