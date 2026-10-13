import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../ink.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { LogOption } from '../types/logs.js'
import { useSessionDelete } from './useSessionDelete.js'

const ACTIVE_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'
const BG_ID = '33333333-3333-4333-8333-333333333333'

function makeLog(sessionId: string): LogOption {
  return {
    sessionId,
    messages: [],
    firstPrompt: 'test prompt',
  } as unknown as LogOption
}

type HookApi = ReturnType<typeof useSessionDelete>

function createTestStreams() {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  return { stdout, stdin }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for useSessionDelete test')
}

function Probe({
  apiRef,
  options,
}: {
  apiRef: { current: HookApi | null }
  options: Parameters<typeof useSessionDelete>[0]
}): React.ReactNode {
  const api = useSessionDelete(options)
  apiRef.current = api
  return null
}

async function renderHook(
  options: Parameters<typeof useSessionDelete>[0],
): Promise<{ apiRef: { current: HookApi | null }; cleanup: () => void }> {
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const apiRef: { current: HookApi | null } = { current: null }
  root.render(<Probe apiRef={apiRef} options={options} />)
  await waitFor(() => apiRef.current !== null)
  return {
    apiRef,
    cleanup: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

function baseOptions(overrides?: Partial<Parameters<typeof useSessionDelete>[0]>) {
  return {
    getActiveSessionId: () => ACTIVE_ID,
    onDeleted: mock(() => {}),
    listRunningSessionIds: async () => new Set<string>(),
    deleteSessionFn: mock(async (_id: string) => {}),
    ...overrides,
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/useSessionDelete.test.tsx')
})

afterEach(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('useSessionDelete', () => {
  test('request on a deletable session opens the pending delete', async () => {
    const options = baseOptions()
    const { apiRef, cleanup } = await renderHook(options)
    try {
      apiRef.current!.handleDeleteRequest(makeLog(TARGET_ID))
      await waitFor(() => apiRef.current!.deletingLog !== null)
      expect(apiRef.current!.isDeletePending).toBe(true)
      expect(apiRef.current!.deleteError).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('confirm deletes, drops the entry, and shows a notice', async () => {
    const options = baseOptions()
    const { apiRef, cleanup } = await renderHook(options)
    try {
      apiRef.current!.handleDeleteRequest(makeLog(TARGET_ID))
      await waitFor(() => apiRef.current!.deletingLog !== null)
      apiRef.current!.handleDeleteConfirm()
      await waitFor(
        () =>
          (options.deleteSessionFn as ReturnType<typeof mock>).mock.calls
            .length > 0,
      )
      await waitFor(() => apiRef.current!.deletingLog === null)
      expect(options.deleteSessionFn).toHaveBeenCalledWith(TARGET_ID)
      expect(options.onDeleted).toHaveBeenCalledWith(TARGET_ID)
      expect(apiRef.current!.deleteNotice).toContain('Deleted')
    } finally {
      cleanup()
    }
  })

  test('cancel clears the pending delete without deleting', async () => {
    const options = baseOptions()
    const { apiRef, cleanup } = await renderHook(options)
    try {
      apiRef.current!.handleDeleteRequest(makeLog(TARGET_ID))
      await waitFor(() => apiRef.current!.deletingLog !== null)
      apiRef.current!.handleDeleteCancel()
      await waitFor(() => apiRef.current!.deletingLog === null)
      expect(options.deleteSessionFn).not.toHaveBeenCalled()
      expect(options.onDeleted).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  test('active session is blocked with an explanatory error', async () => {
    const options = baseOptions()
    const { apiRef, cleanup } = await renderHook(options)
    try {
      apiRef.current!.handleDeleteRequest(makeLog(ACTIVE_ID))
      await waitFor(() => apiRef.current!.deleteError !== null)
      expect(apiRef.current!.deleteError).toContain('active session')
      expect(apiRef.current!.deletingLog).toBeNull()
      expect(options.deleteSessionFn).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  test('live background session is blocked with an explanatory error', async () => {
    const options = baseOptions({
      listRunningSessionIds: async () => new Set([BG_ID]),
    })
    const { apiRef, cleanup } = await renderHook(options)
    try {
      apiRef.current!.handleDeleteRequest(makeLog(BG_ID))
      await waitFor(() => apiRef.current!.deleteError !== null)
      expect(apiRef.current!.deleteError).toContain('background session')
      expect(apiRef.current!.deletingLog).toBeNull()
      expect(options.deleteSessionFn).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  test('already-deleted session drops the entry with an "Already deleted" notice', async () => {
    const options = baseOptions({
      deleteSessionFn: mock(async (_id: string) => {
        throw new Error(`Session not found: ${_id}`)
      }),
    })
    const { apiRef, cleanup } = await renderHook(options)
    try {
      apiRef.current!.handleDeleteRequest(makeLog(TARGET_ID))
      await waitFor(() => apiRef.current!.deletingLog !== null)
      apiRef.current!.handleDeleteConfirm()
      await waitFor(() => apiRef.current!.deletingLog === null)
      expect(options.onDeleted).toHaveBeenCalledWith(TARGET_ID)
      expect(apiRef.current!.deleteNotice).toContain('Already deleted')
    } finally {
      cleanup()
    }
  })
})
