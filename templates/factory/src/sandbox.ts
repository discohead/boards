// A thread's sandbox: the container its ThreadAgent owns (ctx.container), a Linux box with git, gh,
// node, and ripgrep. GitHub's hosts are intercepted on the way out, where GitHubEgress adds the
// thread's token: the sandbox never holds a credential.

type Ctx = DurableObjectState & { exports: Record<string, (options: { props: unknown }) => Fetcher> }

/** Hosts whose requests get the thread's GitHub token on the way out. */
export const GITHUB_HOSTS = ['api.github.com', 'github.com', 'uploads.github.com', 'codeload.github.com']

const SETUP = [
  'set -e',
  // Trust the Cloudflare CA the intercepts present, for git, gh, curl, and node alike.
  'if [ -f /etc/cloudflare/certs/cloudflare-containers-ca.crt ] && ! grep -q CLOUDFLARE-CONTAINERS /etc/ssl/certs/ca-certificates.crt; then { echo "# CLOUDFLARE-CONTAINERS"; cat /etc/cloudflare/certs/cloudflare-containers-ca.crt; } >> /etc/ssl/certs/ca-certificates.crt; fi',
  'mkdir -p /workspace',
  'git config --global user.name "$GIT_NAME"',
  'git config --global user.email "$GIT_EMAIL"',
  'git config --global init.defaultBranch main',
].join('\n')

export type Ran = { exitCode: number; output: string }

export class Sandbox {
  private starting: Promise<void> | null = null
  constructor(private ctx: Ctx, private thread: string, private identity: { name: string; email: string }) {}

  private get container() {
    const container = this.ctx.container
    if (!container) throw new Error('this ThreadAgent has no container configured')
    return container
  }

  /** What every command gets: a home, a placeholder token gh accepts (the real one is added on the way out), and no prompts. */
  private env(): Record<string, string> {
    return {
      HOME: '/root',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      GH_TOKEN: 'added-on-the-way-out',
      GIT_TERMINAL_PROMPT: '0',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
      GIT_NAME: this.identity.name,
      GIT_EMAIL: this.identity.email,
    }
  }

  /** Starts the container if it isn't running, with its intercepts, and waits until it runs commands. */
  ready(): Promise<void> {
    if (this.container.running && !this.starting) return Promise.resolve()
    this.starting ??= (async () => {
      const container = this.container
      const egress = this.ctx.exports.GitHubEgress!({ props: { thread: this.thread } })
      for (const host of GITHUB_HOSTS) {
        await container.interceptOutboundHttps(host, egress)
        await container.interceptOutboundHttp(host, egress)
      }
      if (!container.running) container.start({ image: (container.images as Record<string, string>).base!, enableInternet: true, instance: 'standard-1' })
      const deadline = Date.now() + 120_000
      for (;;) {
        try {
          const probe = await container.exec(['true'])
          if ((await probe.exitCode) === 0) break
        } catch (error) {
          if (Date.now() > deadline) throw new Error('the sandbox did not start: ' + String((error as Error)?.message ?? error))
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      const setup = await this.exec(SETUP, { cwd: '/', timeoutSeconds: 60 })
      if (setup.exitCode !== 0) throw new Error('sandbox setup failed: ' + setup.output.slice(-500))
    })().finally(() => (this.starting = null))
    return this.starting
  }

  private async exec(script: string, options: { cwd?: string; timeoutSeconds?: number } = {}): Promise<Ran> {
    const process = await this.container.exec(['timeout', '--kill-after=10', String(options.timeoutSeconds ?? 600), 'bash', '-lc', script], {
      cwd: options.cwd ?? '/workspace',
      env: this.env(),
      stdout: 'pipe',
      stderr: 'combined',
    })
    const out = await process.output()
    return { exitCode: out.exitCode, output: new TextDecoder().decode(out.stdout) }
  }

  /** A bash script in /workspace, as the agent's bash tool runs it. */
  async run(script: string, options: { cwd?: string; timeoutSeconds?: number } = {}): Promise<Ran> {
    await this.ready()
    return this.exec(script, options)
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    await this.ready()
    const process = await this.container.exec(['bash', '-c', 'if [ -f "$1" ]; then base64 -w0 "$1"; else exit 44; fi', '_', path], { env: this.env(), stdout: 'pipe', stderr: 'pipe' })
    const out = await process.output()
    if (out.exitCode === 44) return null
    if (out.exitCode !== 0) throw new Error(path + ': ' + new TextDecoder().decode(out.stderr).slice(0, 300))
    const text = new TextDecoder().decode(out.stdout)
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    await this.ready()
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const process = await this.container.exec(['bash', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', '_', path], {
      env: this.env(),
      stdin: new Blob([bytes]).stream(),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await process.output()
    if (out.exitCode !== 0) throw new Error(path + ': ' + new TextDecoder().decode(out.stderr).slice(0, 300))
  }
}
