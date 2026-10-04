import type { CiState, PrComment, PrStatus } from '../types'

const GH_TIMEOUT_MS = 20_000
const PREVIEW_MAX = 90
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING = new Set(['PENDING', 'EXPECTED', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED'])

/** GitHub's largest page for a connection. */
const PAGE = 100
/**
 * Comments read per review thread, newest last: the last one says whether the
 * thread waits on the person, and the rest count towards new comments.
 */
const THREAD_COMMENTS = 100
/** Pages read at most per refresh (2,000 threads); a PR past that shows what was read. */
const MAX_PAGES = 20

const COMMENT_FIELDS = 'author{login} path line body createdAt'

/**
 * Where the next GraphQL call starts each connection: null for its first page,
 * an end cursor for the page after it, undefined once it has been read to the end.
 */
export type PrPage = { threadsAfter?: string | null; commentsAfter?: string | null }
export const FIRST_PAGE: PrPage = { threadsAfter: null, commentsAfter: null }

/** The query for one page of the review threads and/or conversation comments still to read. */
function threadsQuery(page: PrPage): string {
  const vars = ['$owner:String!', '$name:String!', '$number:Int!']
  const fields: string[] = []
  if (page.threadsAfter !== undefined) {
    vars.push('$threadsAfter:String')
    fields.push(
      `reviewThreads(first:${PAGE},after:$threadsAfter){pageInfo{hasNextPage endCursor} ` +
        `nodes{isResolved comments(last:${THREAD_COMMENTS}){nodes{${COMMENT_FIELDS}}}}}`,
    )
  }
  if (page.commentsAfter !== undefined) {
    vars.push('$commentsAfter:String')
    fields.push(`comments(first:${PAGE},after:$commentsAfter){pageInfo{hasNextPage endCursor} nodes{author{login} body createdAt}}`)
  }
  return `query(${vars.join(',')}){
  viewer{login}
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    ${fields.join('\n    ')}
  }}
}`
}

type RollupEntry = { conclusion?: string | null; status?: string | null; state?: string | null }
type GqlComment = { author?: { login?: string } | null; path?: string | null; line?: number | null; body?: string; createdAt?: string }
type GqlThread = { isResolved?: boolean; comments?: { nodes?: GqlComment[] } }
type PageInfo = { hasNextPage?: boolean; endCursor?: string | null }
export type ThreadsResponse = {
  data?: {
    viewer?: { login?: string }
    repository?: {
      pullRequest?: {
        reviewThreads?: { pageInfo?: PageInfo; nodes?: GqlThread[] }
        comments?: { pageInfo?: PageInfo; nodes?: GqlComment[] }
      }
    }
  }
}

export function summarizeCi(rollup: readonly RollupEntry[]): CiState {
  if (rollup.length === 0) return 'none'
  const states = rollup.map(r => (r.conclusion || r.state || r.status || '').toUpperCase())
  if (states.some(s => FAILED.has(s))) return 'failing'
  if (states.some(s => PENDING.has(s) || s === '')) return 'running'
  return 'passing'
}

function toComment(c: GqlComment): PrComment {
  const firstLine = (c.body ?? '').split('\n').find(l => l.trim()) ?? ''
  const preview = firstLine.length > PREVIEW_MAX ? `${firstLine.slice(0, PREVIEW_MAX - 1)}…` : firstLine
  return { author: c.author?.login ?? 'someone', path: c.path ?? '', line: c.line ?? null, body: preview, createdAt: c.createdAt ?? '' }
}

/**
 * Unresolved threads, the ones waiting on the viewer (someone else spoke
 * last), comments by others since `seenAt`, and the newest waiting comment.
 */
export function summarizeThreads(
  response: ThreadsResponse,
  seenAt: number,
): Pick<PrStatus, 'unresolved' | 'needReply' | 'newCount' | 'latest'> {
  const pr = response.data?.repository?.pullRequest
  const viewer = response.data?.viewer?.login
  const threads = pr?.reviewThreads?.nodes ?? []
  const open = threads.filter(t => !t.isResolved)
  const everyComment = [...threads.flatMap(t => t.comments?.nodes ?? []), ...(pr?.comments?.nodes ?? [])]
  const newCount = everyComment.filter(
    c => c.author?.login !== viewer && Date.parse(c.createdAt ?? '') > seenAt,
  ).length
  const waiting = open
    .map(t => (t.comments?.nodes ?? []).at(-1))
    .filter((c): c is GqlComment => c !== undefined && c.author?.login !== viewer)
  const latest = [...waiting].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))[0]
  return { unresolved: open.length, needReply: waiting.length, newCount, latest: latest ? toComment(latest) : null }
}

/** Host, owner, name and number from a pull request URL on github.com or a GitHub Enterprise host. */
export function parsePrUrl(url: string): { host: string; owner: string; name: string; number: number } | null {
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url)
  return m ? { host: m[1] ?? '', owner: m[2] ?? '', name: m[3] ?? '', number: Number(m[4]) } : null
}

export const GH_RUN = { timeoutMs: GH_TIMEOUT_MS } as const

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

/** `gh pr view` for a known PR url, or for the branch checked out in the working directory. */
export function viewArgv(url: string | null): string[] {
  return ['gh', 'pr', 'view', ...(url ? [url] : []), '--json', 'number,title,url,state,statusCheckRollup']
}

/** The first GitHub PR link in some text, without anchors or query. */
export function findPrUrl(text: string): string | null {
  return PR_URL.exec(text)?.[0] ?? null
}

/** The PR a Bash command created, edited, commented on or merged, as Claude Code recorded it. */
export function prUrlFromResult(result: unknown): string | null {
  const url = (result as { gitOperation?: { pr?: { url?: unknown } } } | null | undefined)?.gitOperation?.pr?.url
  return typeof url === 'string' ? findPrUrl(url) : null
}

export type PrView = { number: number; title: string; url: string; state: string; statusCheckRollup?: RollupEntry[] }

// gh's answers that mean there is no PR here: none for the branch, no repo,
// no remote, remotes not on a GitHub host, or a detached HEAD (mid-rebase).
const NO_PR_HERE = /no pull requests? found|not a git repository|no git remotes|known GitHub host|could not determine current branch|not on any branch/i

/** What a failed `gh pr view` means: no PR here (null), or a real error to report. */
export function viewError(stderr: string): string | null {
  if (NO_PR_HERE.test(stderr)) return null
  return firstLine(stderr) || 'gh pr view failed'
}

export function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

/**
 * The GraphQL call for one page of a PR's review threads and conversation
 * comments. Owner, name and cursors go as raw strings (-f): -F would send an
 * all-digit name as an Int.
 */
export function threadsArgv(view: PrView, page: PrPage = FIRST_PAGE): string[] | null {
  const where = parsePrUrl(view.url)
  if (!where) return null
  const host = where.host === 'github.com' ? [] : ['--hostname', where.host]
  const cursors = [
    ...(page.threadsAfter ? ['-f', `threadsAfter=${page.threadsAfter}`] : []),
    ...(page.commentsAfter ? ['-f', `commentsAfter=${page.commentsAfter}`] : []),
  ]
  return [
    'gh', 'api', 'graphql', ...host, '-f', `query=${threadsQuery(page)}`,
    '-f', `owner=${where.owner}`, '-f', `name=${where.name}`, '-F', `number=${where.number}`, ...cursors,
  ]
}

/** The page after `asked` for the connections that have more, or null when all were read. */
export function nextPage(response: ThreadsResponse, asked: PrPage): PrPage | null {
  const pr = response.data?.repository?.pullRequest
  const threads = pr?.reviewThreads?.pageInfo
  const comments = pr?.comments?.pageInfo
  const next: PrPage = {}
  if (asked.threadsAfter !== undefined && threads?.hasNextPage && threads.endCursor) next.threadsAfter = threads.endCursor
  if (asked.commentsAfter !== undefined && comments?.hasNextPage && comments.endCursor) next.commentsAfter = comments.endCursor
  return next.threadsAfter === undefined && next.commentsAfter === undefined ? null : next
}

/** Two pages' threads and comments as one response. */
export function mergeThreads(a: ThreadsResponse, b: ThreadsResponse): ThreadsResponse {
  const prA = a.data?.repository?.pullRequest
  const prB = b.data?.repository?.pullRequest
  const viewer = a.data?.viewer ?? b.data?.viewer
  return {
    data: {
      ...(viewer ? { viewer } : {}),
      repository: {
        pullRequest: {
          reviewThreads: { nodes: [...(prA?.reviewThreads?.nodes ?? []), ...(prB?.reviewThreads?.nodes ?? [])] },
          comments: { nodes: [...(prA?.comments?.nodes ?? []), ...(prB?.comments?.nodes ?? [])] },
        },
      },
    },
  }
}

type Ran = { exitCode: number; stdout: string; stderr: string }

/**
 * Every review thread and conversation comment on the PR, page by page, so a
 * thread past the first hundred still counts. `run` runs one gh command.
 */
export async function readThreads(
  view: PrView,
  run: (argv: string[]) => Promise<Ran>,
): Promise<{ threads: ThreadsResponse } | { error: string }> {
  let threads: ThreadsResponse = {}
  let page: PrPage | null = FIRST_PAGE
  for (let n = 0; page && n < MAX_PAGES; n += 1) {
    const argv = threadsArgv(view, page)
    if (!argv) return { error: `unrecognised PR url ${view.url}` }
    const ran = await run(argv)
    if (ran.exitCode !== 0) return { error: firstLine(ran.stderr) || 'gh api graphql failed' }
    const response = JSON.parse(ran.stdout) as ThreadsResponse
    threads = mergeThreads(threads, response)
    page = nextPage(response, page)
  }
  return { threads }
}

export function buildStatus(view: PrView, threads: ThreadsResponse, seenAt: number, now: number): PrStatus {
  return {
    number: view.number,
    title: view.title,
    url: view.url,
    ci: summarizeCi(view.statusCheckRollup ?? []),
    checkedAt: now,
    ...summarizeThreads(threads, seenAt),
  }
}

export function draftRepliesPrompt(pr: PrStatus): string {
  return (
    `Draft replies to the ${pr.needReply} unresolved review threads on PR #${pr.number} (${pr.url}) ` +
    'where someone else commented last, so they are waiting on me. Read each thread and the code it points ' +
    'at, then show me a proposed reply per thread, and say which ones need a code change first. Do not post ' +
    'anything to GitHub.'
  )
}
