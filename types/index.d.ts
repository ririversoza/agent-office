export type WorkerKind = 'lead' | 'opus' | 'sonnet' | 'haiku' | 'fable' | 'codex' | 'cursor' | 'agent'

export type WorkerStatus = 'working' | 'idle' | 'done' | 'failed'

export type Worker = {
  /** 'lead', 'codex', 'cursor', or a subagent's agentId */
  id: string
  /** Desk name plate, e.g. 'implementer' */
  name: string
  kind: WorkerKind
  /** Short model label for the name plate, e.g. 'opus' */
  model: string
  /** What the agent was asked to do */
  task: string
  /** What it is doing right now, e.g. 'editing foo.ts'; empty when nothing */
  activity: string
  status: WorkerStatus
  /** Epoch ms of the last status change */
  changedAt: number
}

export type ChecklistStatus = 'todo' | 'doing' | 'done'

export type ChecklistItem = { text: string; status: ChecklistStatus }

export type Checklist = {
  title: string
  items: ChecklistItem[]
  /** Epoch ms of the last change */
  updatedAt: number
  /** Who wrote it: pasted by the person, or written in one of Claude's replies */
  source: 'user' | 'assistant'
  /** Whether the model has been told the pane tracks it (a user's list is told at once) */
  isAnnounced: boolean
}

export type CiState = 'passing' | 'failing' | 'running' | 'none'

export type PrComment = { author: string; path: string; line: number | null; body: string; createdAt: string }

export type PrStatus = {
  number: number
  title: string
  url: string
  unresolved: number
  /** Unresolved threads whose last comment is someone else's: the ones waiting on the person */
  needReply: number
  /** Review-thread and conversation comments posted after the person last looked */
  newCount: number
  ci: CiState
  /** The newest comment by someone else on a thread that needs a reply, for the one-line preview */
  latest: PrComment | null
  /** Epoch ms of the last successful refresh */
  checkedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-office': {
      workers: Worker[]
      isOpened: boolean
      checklist: Checklist | null
      pr: PrStatus | null
      /** The PR this session works on, once a command or prompt names it */
      prUrl: string | null
      /** The newest reply checklist already seen, so an older one is never re-adopted */
      seenReplyKey: string | null
      /** A /harness plan.json the whiteboard follows, until another checklist takes over */
      planFile: string | null
    }
  }
}
