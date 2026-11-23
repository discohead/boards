// Bindings wrangler types can't see: a development secret from .dev.vars, which CI doesn't have.
declare namespace Cloudflare {
  interface Env {
    /** wrangler dev only: a board token the server reads with (there's no Access locally). */
    WORKBUS_DEV_TOKEN?: string
    /** How long a seat's running operation may go before its Seat stops it (ms; 15 minutes when unset). */
    WATCHDOG_STALL_MS?: string
  }
}
