// The agent's skills: it sees each one's name and description, and reads one in full with read_skill.
import board from '../skills/board.md'
import checkIns from '../skills/check-ins.md'
import openPr from '../skills/open-pr.md'
import prLifecycle from '../skills/pr-lifecycle.md'
import reproduceBug from '../skills/reproduce-bug.md'
import reviewPr from '../skills/review-pr.md'
import feedback from '../skills/feedback.md'
import tryIt from '../skills/try-it.md'

export type Skill = { name: string; description: string; body: string }

function parse(source: string): Skill {
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(source)
  const field = (key: string) => new RegExp('^' + key + ':\\s*(.*)$', 'm').exec(front?.[1] ?? '')?.[1]?.replace(/^["']|["']$/g, '').trim() ?? ''
  return { name: field('name'), description: field('description'), body: front ? source.slice(front[0].length) : source }
}

export const SKILLS: Skill[] = [board, checkIns, openPr, prLifecycle, reproduceBug, reviewPr, feedback, tryIt].map(parse)
export const skillIndex = () => SKILLS.map((skill) => '- ' + skill.name + ': ' + skill.description).join('\n')
