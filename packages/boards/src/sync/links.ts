// What a platform link names, read from the link alone: the platform is never asked. Each answer is
// in the board's sync terms (a platform thread under a sync key, and maybe a message in it), or, for
// Linear, the issue identifier its root is labeled with.

export type LinkTarget =
  | { platform: string; thread: (key: string) => string; message: string | null }
  | { platform: 'linear'; issue: string; comment: string | null }

/** The places a link may name, one for each platform whose link it is. */
export function linkTargets(raw: string): LinkTarget[] {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return []
  }
  const parts = url.pathname.split('/').filter(Boolean)
  // github.com/<owner>/<repo>/(issues|pull)/<n>[#issuecomment-<id>|#discussion_r<id>|#pullrequestreview-<id>]
  if (url.hostname === 'github.com' && parts.length >= 4 && (parts[2] === 'issues' || parts[2] === 'pull') && /^\d+$/.test(parts[3]!)) {
    const repo = parts[0] + '/' + parts[1]
    const hash = url.hash.slice(1)
    const message = /^issuecomment-(\d+)$/.exec(hash)?.[1] ? 'comment-' + /^issuecomment-(\d+)$/.exec(hash)![1]
      : /^discussion_r(\d+)$/.exec(hash)?.[1] ? 'rc-' + /^discussion_r(\d+)$/.exec(hash)![1]
      : /^pullrequestreview-(\d+)$/.exec(hash)?.[1] ? 'review-' + /^pullrequestreview-(\d+)$/.exec(hash)![1]
      : null
    return [{ platform: 'github', thread: (key) => key + ':' + repo + ':' + parts[3], message }]
  }
  // <workspace>.slack.com/archives/<channel>/p<ts without its dot>[?thread_ts=<thread ts>]
  if (url.hostname.endsWith('.slack.com') && parts[0] === 'archives' && parts.length >= 3 && /^p\d{7,}$/.test(parts[2]!)) {
    const digits = parts[2]!.slice(1)
    const ts = digits.slice(0, -6) + '.' + digits.slice(-6)
    const threadTs = url.searchParams.get('thread_ts') ?? ts
    return [{ platform: 'slack', thread: (key) => key + ':' + parts[1] + ':' + threadTs, message: ts }]
  }
  // linear.app/<workspace>/issue/<TEAM-123>[/<slug>][#comment-<id>]
  if (url.hostname === 'linear.app' && parts.length >= 3 && parts[1] === 'issue' && /^[A-Za-z0-9]+-\d+$/.test(parts[2]!)) {
    const comment = /^comment-([0-9a-f-]+)$/i.exec(url.hash.slice(1))?.[1] ?? null
    return [{ platform: 'linear', issue: parts[2]!.toUpperCase(), comment: comment ? 'comment-' + comment : null }]
  }
  return []
}
