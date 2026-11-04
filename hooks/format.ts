// Pure helpers: labels, step text, model names, the conflict judge, take-home.
import { clip, historyTurns, memberName } from './lib/helpers.ts'
import type { MemberId, SpaceState, Turn } from './lib/types.ts'

/** "Sam's turn", "Sam and Riley's turn", "your turn". */
export function turnLabel(s: SpaceState, t: Turn, me: MemberId): string {
  if (t.mode === 'aside') return t.senderId === me ? 'your side question' : `${memberName(s, t.senderId)}’s side question`
  if (t.mode === 'recap') return t.senderId === me ? 'your recap' : `${memberName(s, t.senderId)}’s recap`
  if (t.senderId !== me) return `${memberName(s, t.senderId)}’s turn`
  const others = [...new Set(t.parts.map((p) => p.memberId))].filter((m) => m !== me)
  if (!others.length) return 'your turn'
  const names = others.map((m) => memberName(s, m))
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${who}’s turn`
}

/** Makes a path safe to show others: relative to the working directory, else its last part. */
export function sharePath(p: string, cwd: string): string {
  if (!p) return p
  const norm = p.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root && (norm === root || norm.startsWith(root + '/'))) return norm.slice(root.length + 1) || '.'
  if (/^([a-zA-Z]:)?\//.test(norm) || norm.startsWith('~')) return `…/${norm.split('/').filter(Boolean).pop() ?? ''}`
  return norm
}

/** Removes the working directory and home folder from free text (a shell command). */
export function scrub(text: string, cwd: string, home?: string): string {
  let t = text
  const root = cwd.replace(/\/+$/, '')
  if (root.length > 1) t = t.split(root + '/').join('').split(root).join('.')
  if (home && home.length > 1) t = t.split(home).join('~')
  return t
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function hostOf(url: string): string {
  const m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i)
  return m ? m[1].toLowerCase() : ''
}

/** One line for a step, from the tool and its input, with nothing local in it. Imperative, as the design writes steps, so it reads right while the step waits, runs and after. */
export function describeTool(tool: string, input: Record<string, unknown>, cwd: string, home?: string): string {
  const path = (k: string) => sharePath(str(input[k]), cwd)
  switch (tool) {
    case 'ExitPlanMode': return 'Put the plan up for approval'
    case 'Read': return `Read ${path('file_path')}`
    case 'Write': return `Write ${path('file_path')}`
    case 'Edit': case 'MultiEdit': return `Edit ${path('file_path')}`
    case 'NotebookEdit': return `Edit ${path('notebook_path')}`
    case 'Bash': return `Run ${clip(scrub(str(input.command), cwd, home), 80)}`
    case 'Glob': return `List ${clip(str(input.pattern), 60)}`
    case 'Grep': return `Search for ${clip(str(input.pattern), 60)}`
    case 'WebFetch': return `Open ${hostOf(str(input.url)) || 'a page'}`
    case 'WebSearch': return `Search the web for ${clip(str(input.query), 60)}`
    case 'Agent': case 'Task': return `Ask a subagent: ${clip(str(input.description), 60)}`
    case 'TodoWrite': return 'Update the to-do list'
    case 'Skill': return `Use the ${clip(str(input.skill), 40)} skill`
    default: {
      if (tool === 'mcp__multiplayer__propose_decision') return `Propose a decision: ${clip(str(input.text), 60)}`
      if (tool === 'mcp__multiplayer__add_question') return `Add an open question: ${clip(str(input.text), 60)}`
      const m = tool.match(/^mcp__(.+?)__(.+)$/)
      return m ? `Use ${m[2]} (${m[1]})` : `Use ${tool}`
    }
  }
}

// ------------------------------------------------------------ conflict judge

export type Verdict = { summary: string; conflicting: number[] } | null

/** The parts the judge reads: in a view-first turn the held-back positions are meant to differ. */
export function judgedParts(t: Turn): number[] {
  return t.parts.map((_, i) => i).filter((i) => !(t.mode === 'view-first' && t.parts[i].position))
}

export function judgePrompt(s: SpaceState, t: Turn): string {
  const lines = judgedParts(t).map((i) => `[${i}] ${memberName(s, t.parts[i].memberId)}: ${clip(t.parts[i].text, 1500)}`)
  return [
    'Several people wrote parts of one message to an AI assistant. Decide whether any two parts written by different people ask for contradictory things, so that the assistant could not honour both.',
    'Different topics, extra detail, or one part refining another are NOT contradictions. Only a real either/or counts.',
    '',
    lines.join('\n'),
    '',
    'Answer with JSON only, no prose: {"conflict": true|false, "summary": "<one short sentence naming who wants what>", "conflicting": [<the part numbers that clash>]}',
  ].join('\n')
}

export function parseVerdict(text: string, t: Turn): Verdict {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let v: { conflict?: unknown; summary?: unknown; conflicting?: unknown }
  try { v = JSON.parse(m[0]) } catch { return null }
  if (v.conflict !== true) return null
  const eligible = new Set(judgedParts(t))
  const idx = Array.isArray(v.conflicting) ? v.conflicting.filter((n): n is number => Number.isInteger(n) && eligible.has(n)) : []
  const conflicting = [...new Set(idx)]
  const authors = new Set(conflicting.map((i) => t.parts[i].memberId))
  if (conflicting.length < 2 || authors.size < 2) return null
  return { summary: clip(typeof v.summary === 'string' && v.summary.trim() ? v.summary : 'These parts ask for opposite things.', 200), conflicting }
}

// ------------------------------------------------------------- take-home

/** The branch's conversation as plain text, oldest first, for continuing solo. */
export function branchTranscript(s: SpaceState, branchId: string, maxChars = 60_000): { text: string; turns: number } {
  const turns = historyTurns(s, branchId).filter((t) => t.status === 'done' || t.status === 'stopped')
  const blocks = turns.map((t) => {
    const who = t.mode === 'merge-note' ? 'Merge note' : t.parts.map((p) => `${memberName(s, p.memberId)}: ${p.text}`).join('\n\n')
    const answer = t.status === 'stopped' ? `${t.text} [stopped]` : t.text
    return `${who}\n\nClaude (run by ${memberName(s, t.runnerId)}): ${answer}`
  })
  let out: string[] = []
  let used = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (used + blocks[i].length > maxChars && out.length) { out = [`[${i + 1} earlier turn${i ? 's' : ''} left out]`, ...out]; break }
    out = [blocks[i], ...out]
    used += blocks[i].length
  }
  return { text: out.join('\n\n---\n\n'), turns: turns.length }
}

/** Splits `/multiplayer` arguments, keeping "quoted words" together. */
export function splitArgs(args: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

