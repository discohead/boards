// Bindings wrangler types can't see: a development secret from .dev.vars, which CI doesn't have.
declare namespace Cloudflare {
  interface Env {
    /** wrangler dev only: a board token the server reads with (there's no Access locally). */
    WORKBUS_DEV_TOKEN?: string
  }
}
