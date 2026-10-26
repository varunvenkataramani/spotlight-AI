// Prints a valid admin session cookie value for tests. Usage: node scripts/test/make-session.ts <userId> <email>
import { createSignedValue } from "../../src/lib/signed-value.ts";

const [userId, email] = process.argv.slice(2);
const secret = process.env.SESSION_SECRET;
if (!userId || !email || !secret) {
  console.error("usage: SESSION_SECRET=... node scripts/test/make-session.ts <userId> <email>");
  process.exit(1);
}
console.log(createSignedValue({ userId, email, name: "CI Admin" }, 3600, secret));
