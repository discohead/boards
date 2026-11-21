// Errors are data: a class that fixes the exit code, a reason to branch on, a headline that says
// what failed and why, and at most two ways out, each a command as argv or a sentence.

export class Failure extends Error {
  /**
   * @param {{ reason: string, headline: string, ways?: (string | string[])[], exitCode?: number,
   *   origin?: 'cli' | 'board', board?: { status: number, code: string, message: string, hint?: string } | null,
   *   data?: Record<string, unknown> }} init
   */
  constructor(init) {
    super(init.headline)
    this.name = 'Failure'
    this.reason = init.reason
    this.headline = init.headline
    this.ways = (init.ways ?? []).slice(0, 2)
    this.exitCode = init.exitCode ?? 1
    this.origin = init.origin ?? 'cli'
    this.board = init.board ?? null
    this.data = init.data ?? null
  }

  toJSON() {
    return {
      error: {
        reason: this.reason,
        message: this.headline,
        origin: this.origin,
        ...(this.board ? { board: this.board } : {}),
        ...(this.ways.length ? { ways: this.ways } : {}),
        ...(this.data ? { data: this.data } : {}),
      },
    }
  }

  /** The text a person reads on stderr. */
  toText() {
    const lines = ['error: ' + this.headline]
    if (this.board) {
      lines.push('  ' + this.board.status + ' ' + this.board.code + '  ' + oneLine(this.board.message))
      if (this.board.hint) lines.push('  ' + oneLine(this.board.hint))
    }
    if (this.ways.length) {
      lines.push('')
      for (const way of this.ways) lines.push('  ' + (Array.isArray(way) ? way.map(quoteArg).join(' ') : way))
    }
    return lines.join('\n')
  }
}

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim()

/** An argument as a shell would need it written. */
export function quoteArg(arg) {
  return /^[A-Za-z0-9_@%+=:,./#-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'"
}

/** Misuse: the command was asked wrongly (exit 2). */
export const misuse = (reason, headline, ways = []) => new Failure({ reason, headline, ways, exitCode: 2 })

/** An error the CLI raised itself (exit 1). */
export const failure = (reason, headline, ways = [], data) => new Failure({ reason, headline, ways, ...(data ? { data } : {}) })
