import type { ElementTable } from 'claude-code'

import type { Checklist, ChecklistStatus, CiState, PrStatus } from '../types'
import { progress } from './checklist'

/** The elements every surface draws, which is all these sections use. */
export type BasicElements = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Button'>

const PROGRESS_CELLS = 20
const ITEM_MARK: Record<ChecklistStatus, string> = { done: '✓', doing: '◐', todo: '○' }
const CI_TEXT: Record<CiState, { label: string; color: string | undefined }> = {
  passing: { label: 'CI passing', color: 'green' },
  failing: { label: 'CI failing', color: 'red' },
  running: { label: 'CI running', color: 'yellow' },
  none: { label: 'no CI checks', color: undefined },
}

/** The session's pull request: unresolved threads, new comments, CI, newest open comment. */
export function prSection(els: BasicElements, pr: PrStatus, onDraftReplies: () => void) {
  const { Box, Text, Button } = els
  const ci = CI_TEXT[pr.ci]
  const where = pr.latest?.path ? ` on ${pr.latest.path}${pr.latest.line ? `:${pr.latest.line}` : ''}` : ''
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold wrap="truncate-end">
        PR #{pr.number} · {pr.title}
      </Text>
      <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
        <Text color={pr.needReply > 0 ? 'yellow' : 'green'}>
          {pr.needReply > 0 ? `${pr.needReply} need a reply` : 'nothing waiting on you'}
        </Text>
        {pr.unresolved > 0 && <Text dimColor>{pr.unresolved} unresolved</Text>}
        {pr.newCount > 0 && <Text color="cyan">{pr.newCount} new</Text>}
        <Text color={ci.color} dimColor={ci.color === undefined}>
          {ci.label}
        </Text>
        {pr.needReply > 0 && <Button key="draft-replies" label="Draft replies" onPress={onDraftReplies} />}
      </Box>
      {pr.latest && (
        <Text dimColor wrap="truncate-end">
          {pr.latest.author}
          {where}: “{pr.latest.body}”
        </Text>
      )}
    </Box>
  )
}

/** The checklist with a progress bar; the item in progress is highlighted. */
export function checklistSection(els: BasicElements, list: Checklist) {
  const { Box, Text } = els
  const { done, total } = progress(list)
  const filled = total === 0 ? 0 : Math.round((done / total) * PROGRESS_CELLS)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold wrap="truncate-end">
          {list.title}
        </Text>
        <Text dimColor>
          {done} of {total}
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text color="green">{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(PROGRESS_CELLS - filled)}</Text>
      </Box>
      {list.items.map(item => (
        <Text
          dimColor={item.status === 'done'}
          strikethrough={item.status === 'done'}
          bold={item.status === 'doing'}
          color={item.status === 'doing' ? 'cyan' : undefined}
          wrap="wrap"
        >
          {ITEM_MARK[item.status]} {item.text}
        </Text>
      ))}
    </Box>
  )
}
