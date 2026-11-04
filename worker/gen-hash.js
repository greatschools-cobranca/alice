// Gera o hash de senha no formato que o worker espera: "pbkdf2$<iterações>$<salt>$<hash>".
// Uso:  node gen-hash.js "minhaSenhaForte123"
// (Hashes antigos no formato "salt$hash" continuam funcionando e são atualizados sozinhos no próximo login.)
const crypto = require("crypto");

const password = process.argv[2];
if (!password) {
  console.error('Uso: node gen-hash.js "senha"');
  process.exit(1);
}

const iterations = 20000; // mesmo valor de worker/src/lib/auth.js
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");

console.log(`pbkdf2$${iterations}$${salt}$${hash}`);
