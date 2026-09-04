// Gera o hash de senha no formato que o worker espera: "salt$hash".
// Uso:  node gen-hash.js "minhaSenhaForte123"
const crypto = require("crypto");

const password = process.argv[2];
if (!password) {
  console.error('Uso: node gen-hash.js "senha"');
  process.exit(1);
}

const salt = crypto.randomBytes(8).toString("hex");
const hash = crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");

console.log(`${salt}$${hash}`);
