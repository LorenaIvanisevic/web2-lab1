import 'dotenv/config';
import { getToken, issuePass } from './src/task2/automat';

async function main() {
  const token = await getToken(
    process.env.ISSUER_BASE_URL!,
    process.env.AUDIENCE!,
    process.env.M2M_CLIENT_ID!,
    process.env.M2M_CLIENT_SECRET!,
    'create:passes'
  );
  console.log(token);
  await issuePass('http://localhost:3000/passes', token, 'aaaa', 'HR-123456789');
  }

main().catch((e) => {
  console.error(e);
  process.exit(1);
});