import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FlowEdge, FlowNode } from './types/flow'
import type { ChatMessage } from './types/chat'
import ProjectPicker, { type ProjectOpenResult } from './components/ProjectPicker'
import FlowWorkspace from './components/FlowWorkspace'
import { applyTheme, getInitialTheme, THEME_STORAGE_KEY, type Theme } from './lib/theme'
import { trpc } from './lib/trpc'
import { listRunningChatIds, subscribeRunningChatJobs } from './lib/running-chat-jobs'

interface ProjectInfo {
  path: string
  name: string
}

interface ProjectState {
  nodes: FlowNode[]
  edges: FlowEdge[]
  chat: ChatMessage[]
  autoLayoutLocked?: boolean
}

interface WorkspaceSession {
  project: ProjectInfo
  initialState: ProjectState
}

const toProjectState = (result: ProjectOpenResult): ProjectState => ({
  nodes: result.state.nodes,
  edges: result.state.edges,
  chat: result.state.chat ?? [],
  autoLayoutLocked:
    typeof result.state.autoLayoutLocked === 'boolean'
      ? result.state.autoLayoutLocked
      : true,
})

function App() {
  const [projectSessions, setProjectSessions] = useState<WorkspaceSession[]>([])
  const [activeProjectPath, setActiveProjectPath] = useState<string | null>(null)
  const [runningProjectPaths, setRunningProjectPaths] = useState<Set<string>>(
    () => new Set(),
  )
  const [initializing, setInitializing] = useState(true)
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme())

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  const handleOpen = useCallback((result: ProjectOpenResult) => {
    const nextProject: ProjectInfo = { path: result.path, name: result.name }
    const nextState = toProjectState(result)
    setProjectSessions((previous) => {
      const existingIndex = previous.findIndex(
        (session) => session.project.path === nextProject.path,
      )
      if (existingIndex < 0) {
        return [...previous, { project: nextProject, initialState: nextState }]
      }
      return previous.map((session, index) =>
        index === existingIndex ? { ...session, project: nextProject } : session,
      )
    })
    setActiveProjectPath(nextProject.path)
  }, [])

  useEffect(() => {
    let cancelled = false
    trpc.project.openDefault
      .mutate()
      .then((result) => {
        if (cancelled) {
          return
        }
        handleOpen(result)
      })
      .catch((error) => {
        if (cancelled) {
          return
        }
        throw error
      })
      .finally(() => {
        if (cancelled) {
          return
        }
        setInitializing(false)
      })
    return () => {
      cancelled = true
    }
  }, [handleOpen])

  useEffect(() => {
    const refresh = () => {
      setRunningProjectPaths(() => {
        const next = new Set<string>()
        projectSessions.forEach((session) => {
          if (listRunningChatIds(session.project.path).size > 0) {
            next.add(session.project.path)
          }
        })
        return next
      })
    }
    refresh()
    return subscribeRunningChatJobs(refresh)
  }, [projectSessions])

  const mountedProjectSessions = useMemo(
    () =>
      projectSessions.filter(
        (session) =>
          session.project.path === activeProjectPath ||
          runningProjectPaths.has(session.project.path),
      ),
    [activeProjectPath, projectSessions, runningProjectPaths],
  )

  if (initializing && projectSessions.length === 0) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
        <div className="rounded-xl border border-border/70 bg-card/80 px-6 py-4 text-xs uppercase tracking-[0.3em] text-muted-foreground shadow-lg">
          Loading workspace...
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen">
      {mountedProjectSessions.map((session) => {
        const isProjectVisible = session.project.path === activeProjectPath
        return (
          <div
            key={session.project.path}
            className={isProjectVisible ? 'h-full w-full' : 'hidden'}
          >
            <FlowWorkspace
              project={session.project}
              initialState={session.initialState}
              isVisible={isProjectVisible}
              theme={theme}
              onToggleTheme={() =>
                setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
              }
              onExit={() => {
                setActiveProjectPath(null)
              }}
            />
          </div>
        )
      })}
      {activeProjectPath ? null : (
        <ProjectPicker onOpen={handleOpen} />
      )}
    </div>
  )
}

export default App
