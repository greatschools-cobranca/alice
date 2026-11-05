import { DatabaseSync } from "node:sqlite";

// FULL+WAL: a intenção é persistida antes de qualquer comando com efeito.
// Uma queda entre envio e confirmação vira incerta; nunca é reenviada às cegas.
export class Journal {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, phase TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  get(id) { const row = this.db.prepare("SELECT data FROM jobs WHERE id=?").get(id); return row ? JSON.parse(row.data) : null; }
  put(record, result) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM jobs WHERE phase IN ('done','error','rejected','skipped') AND at < ? AND id NOT IN (SELECT id FROM outbox)").run(Date.now() - 7 * 86400000);
      if (!this.get(record.id) && this.db.prepare("SELECT count(*) AS n FROM jobs").get().n >= 500) throw new Error("journal_capacity");
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,data=excluded.data,at=excluded.at").run(record.id, record.phase, JSON.stringify(record), Date.now());
      if (result) this.db.prepare("INSERT INTO outbox VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(record.id, JSON.stringify(result));
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  pendingResults() { return this.db.prepare("SELECT id,data FROM outbox LIMIT 100").all().map(r => ({ id: r.id, ...JSON.parse(r.data) })); }
  ack(id) { this.db.prepare("DELETE FROM outbox WHERE id=?").run(id); }
  // O serviço Docker inicia obrigatoriamente com flock; o kernel solta a trava após queda.
  close() { this.db.close(); }
}
