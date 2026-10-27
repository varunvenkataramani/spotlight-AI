// Prints a value encrypted the way Spotlight stores Gmail tokens. Usage: node scripts/test/encrypt.ts <value>
import { encryptSecret, parseEncryptionKey } from "../../src/lib/token-crypto.ts";

const value = process.argv[2];
const key = process.env.TOKEN_ENCRYPTION_KEY;
if (!value || !key) {
  console.error("usage: TOKEN_ENCRYPTION_KEY=... node scripts/test/encrypt.ts <value>");
  process.exit(1);
}
console.log(encryptSecret(value, parseEncryptionKey(key)));
