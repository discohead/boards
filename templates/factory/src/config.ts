// What this factory works on, and where it talks: edit this file to change it. The agent opens a
// pull request against the factory's own repo when you ask it to onboard a repo.

/** The factory's name: what it's called on the board, and what its channels are named for. */
export const NAME = 'factory'

/** Its channels: one of its own, and one under it per repo. */
export const HOME = 'project-' + NAME
export const channel = (name?: string) => (name ? HOME + '/' + name : HOME)

/** Where people talk with the agent about the factory itself. */
export const RSI = channel('rsi')

/** Each repo the factory works on (owner/name, as GitHub writes it), and the board channel its issues and pull requests come into. */
export const REPOS: Record<string, string> = {
  'discohead/factory-playground': channel('playground'),
}

/** The factory's own repo, where it changes itself when asked, or null. */
export const OWN_REPO: string | null = null

/** The factory's living doc of how it works: one section per area, kept by the agent (skills/feedback.md). */
export const HOW_WE_WORK = { channel: channel('factory'), slug: 'how-we-work' }
export const HOW_WE_WORK_PATH = HOW_WE_WORK.channel + '/' + HOW_WE_WORK.slug

/** What the agent may do on the board: read, post, react, and label in its own channels, nowhere else; and edit the docs in its own. */
export const AGENT_CAN = HOME + '/=read,post,react,label;' + HOW_WE_WORK.channel + '=read,post,react,label,edit'
