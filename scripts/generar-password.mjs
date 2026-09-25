// scripts/generar-password.mjs
//
// Genera el hash y la sal de una contraseña con el MISMO algoritmo que usa
// _worker.js (PBKDF2-SHA256, 100000 iteraciones, 256 bits), para la
// contraseña de administrador. Se ejecuta en tu propio ordenador: la
// contraseña nunca sale de tu máquina ni pasa por ningún chat.
//
// Uso:
//   node scripts/generar-password.mjs "tu-contraseña-de-admin"
//
// Te imprime los dos comandos `wrangler secret put` que tienes que ejecutar
// (te pedirá pegar cada valor por separado).

import { webcrypto } from "node:crypto";
const { subtle } = webcrypto;

const password = process.argv[2];
if (!password) {
  console.error('Uso: node scripts/generar-password.mjs "tu-contraseña"');
  process.exit(1);
}
if (password.length < 6) {
  console.error("La contraseña debe tener al menos 6 caracteres.");
  process.exit(1);
}

function toB64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function hash(password, saltBytes) {
  const key = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" }, key, 256);
  return toB64(new Uint8Array(bits));
}

const saltBytes = webcrypto.getRandomValues(new Uint8Array(16));
const saltB64 = toB64(saltBytes);
const hashB64 = await hash(password, saltBytes);

console.log("\nEjecuta estos dos comandos (te pedirán pegar el valor):\n");
console.log(`  wrangler secret put ADMIN_PASSWORD_HASH`);
console.log(`    -> pega: ${hashB64}\n`);
console.log(`  wrangler secret put ADMIN_PASSWORD_SALT`);
console.log(`    -> pega: ${saltB64}\n`);
