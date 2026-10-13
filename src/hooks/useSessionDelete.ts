import * as React from 'react'

import { listBackgroundSessions } from '../cli/bgRegistry.js'
import { getResumeLogDisplayTitle } from '../components/LogSelector.js'
import { deleteSession } from '../entrypoints/sdk/sessions.js'
import { getDeleteBlockReason } from '../screens/resumeDeleteGuards.js'
import { logEvent } from '../services/analytics/index.js'
import type { LogOption } from '../types/logs.js'
import { errorMessage } from '../utils/errors.js'
import { getSessionIdFromLog } from '../utils/sessionStorage.js'

export type UseSessionDeleteOptions = {
  /** Returns the id of the currently active session (never deletable). */
  getActiveSessionId: () => string
  /** Called after a successful delete so the host can drop the entry. */
  onDeleted: (sessionId: string) => void
  /** Override for tests. Defaults to live background-session lookup. */
  listRunningSessionIds?: () => Promise<ReadonlySet<string>>
  /** Override for tests. Defaults to the real session-file deletion. */
  deleteSessionFn?: (sessionId: string) => Promise<void>
}

async function defaultListRunningSessionIds(): Promise<ReadonlySet<string>> {
  const bgSessions = await listBackgroundSessions()
  return new Set(
    bgSessions
      .filter(s => s.status === 'running' || s.status === 'unknown')
      .map(s => s.sessionId),
  )
}

/**
 * Shared delete state machine for session pickers (Del-to-delete flow).
 *
 * Extracted from the `--resume` CLI picker (`ResumeConversation`, which keeps
 * its own inline copy untouched) so the in-REPL `/resume` and `/replay`
 * pickers share identical guard/confirm/dialog behavior with zero drift.
 * Hosts render `DeleteSessionConfirm` + error/notice banners themselves and
 * pass `handleDeleteRequest` / `isDeletePending` to `LogSelector`.
 */
export function useSessionDelete({
  getActiveSessionId,
  onDeleted,
  listRunningSessionIds = defaultListRunningSessionIds,
  deleteSessionFn = deleteSession,
}: UseSessionDeleteOptions): {
  deletingLog: LogOption | null
  deleteError: string | null
  deleteNotice: string | null
  isDeletePending: boolean
  handleDeleteRequest: (log: LogOption) => void
  handleDeleteConfirm: () => void
  handleDeleteCancel: () => void
} {
  const [deletingLog, setDeletingLog] = React.useState<LogOption | null>(null)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [deleteNotice, setDeleteNotice] = React.useState<string | null>(null)

  async function handleDeleteRequest(log: LogOption): Promise<void> {
    const targetId = getSessionIdFromLog(log)
    setDeleteError(null)
    setDeleteNotice(null)
    if (!targetId) {
      setDeleteError('Cannot determine the session id for this entry.')
      return
    }
    if (targetId === getActiveSessionId()) {
      setDeleteError('Cannot delete the active session.')
      return
    }
    try {
      const runningIds = await listRunningSessionIds()
      const blockReason = getDeleteBlockReason(
        targetId,
        getActiveSessionId(),
        runningIds,
      )
      if (blockReason) {
        setDeleteError(blockReason)
        return
      }
    } catch (e) {
      setDeleteError(`Failed to check background sessions: ${errorMessage(e)}`)
      return
    }
    setDeletingLog(log)
  }

  async function handleDeleteConfirm(): Promise<void> {
    const target = deletingLog
    if (!target) return
    const targetId = getSessionIdFromLog(target)
    if (!targetId) {
      setDeletingLog(null)
      return
    }
    try {
      await deleteSessionFn(targetId)
      onDeleted(targetId)
      setDeletingLog(null)
      setDeleteNotice(`Deleted ${getResumeLogDisplayTitle(target)}.`)
      logEvent('tengu_session_delete', {
        confirmed: true,
        success: true,
      })
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Session not found')) {
        onDeleted(targetId)
        setDeletingLog(null)
        setDeleteNotice('Already deleted.')
        logEvent('tengu_session_delete', {
          confirmed: true,
          success: true,
        })
        return
      }
      setDeleteError(`Failed to delete: ${errorMessage(e)}`)
      logEvent('tengu_session_delete', {
        confirmed: true,
        success: false,
      })
    }
  }

  function handleDeleteCancel(): void {
    logEvent('tengu_session_delete', {
      confirmed: false,
    })
    setDeletingLog(null)
  }

  return {
    deletingLog,
    deleteError,
    deleteNotice,
    isDeletePending: deletingLog !== null,
    handleDeleteRequest: (log: LogOption) => void handleDeleteRequest(log),
    handleDeleteConfirm: () => void handleDeleteConfirm(),
    handleDeleteCancel,
  }
}
