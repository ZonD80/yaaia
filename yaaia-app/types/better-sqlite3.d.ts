declare module "better-sqlite3" {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  class Database {
    constructor(path: string);
    exec(sql: string): this;
    prepare(sql: string): Statement;
    close(): void;
    transaction<T extends (...args: unknown[]) => void>(fn: T): T;
  }
  export default Database;
}
