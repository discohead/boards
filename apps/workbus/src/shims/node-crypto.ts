// The browser has no node:crypto. The board's section parser (workbus/ledger/doctext.ts) imports
// createHash for the section hashes the Ledger keeps, which the app never computes: this stands in
// for it in the client build only (vite.config.ts), until the parser and the hashing are split.
// TODO(step 2): delete with reader's doctext split (ledger/doctrack.ts, PR #4).
export function createHash(): never {
  throw new Error('node:crypto is not available in the browser')
}
