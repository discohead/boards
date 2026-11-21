// Synchronous SQL on the Ledger's own SQLite. A Durable Object binds at most 100 parameters to a
// statement, so an IN list longer than that goes as one JSON array (json_each).

export type Row = Record<string, SqlStorageValue>

const MAX_BINDINGS = 100

export class Sql {
  private storage: DurableObjectStorage
  constructor(storage: DurableObjectStorage) {
    this.storage = storage
  }

  all<T = Row>(query: string, ...bindings: unknown[]): T[] {
    return this.storage.sql.exec(query, ...bindings.map(bind)).toArray() as T[]
  }
  one<T = Row>(query: string, ...bindings: unknown[]): T | null {
    return (this.all<T>(query, ...bindings)[0] ?? null) as T | null
  }
  run(query: string, ...bindings: unknown[]): number {
    const cursor = this.storage.sql.exec(query, ...bindings.map(bind))
    cursor.toArray()
    return cursor.rowsWritten
  }
  /** A JSON array to bind for "in (select value from json_each(?))", whatever its length. */
  list(values: readonly unknown[]): string {
    return JSON.stringify(values)
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn)
  }
  get maxBindings() {
    return MAX_BINDINGS
  }
}

function bind(value: unknown): SqlStorageValue {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object' && !(value instanceof ArrayBuffer)) return JSON.stringify(value)
  return value as SqlStorageValue
}

export const json = <T>(value: SqlStorageValue | undefined, fallback: T): T => (typeof value === 'string' && value !== '' ? (JSON.parse(value) as T) : fallback)
