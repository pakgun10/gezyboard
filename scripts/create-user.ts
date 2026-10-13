// Membuat user pemilik GezyBoard.
// Pakai: bun run scripts/create-user.ts <username> <password>
import { createUser, getUserByUsername, hashPassword } from "../src/auth";

const [username, password] = Bun.argv.slice(2);
if (!username || !password) {
  console.error("Pakai: bun run scripts/create-user.ts <username> <password>");
  process.exit(1);
}
if (getUserByUsername(username)) {
  console.error(`User "${username}" sudah ada.`);
  process.exit(1);
}
const user = createUser(username, await hashPassword(password));
console.log(`User "${user.username}" dibuat (id=${user.id}). Silakan login di halaman utama.`);
