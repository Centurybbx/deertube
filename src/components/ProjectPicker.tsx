import { useEffect, useState } from 'react'
import { trpc } from '../lib/trpc'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { FlowEdge, FlowNode } from '@/types/flow'
import type { ChatMessage } from '@/types/chat'

export interface ProjectOpenResult {
  path: string
  name: string
  state: {
    nodes: FlowNode[]
    edges: FlowEdge[]
    chat?: ChatMessage[]
    autoLayoutLocked?: boolean
  }
}

interface RecentProject {
  path: string
  name: string
  lastOpened: string
}

interface ProjectPickerProps {
  onOpen: (project: ProjectOpenResult) => void
}

export default function ProjectPicker({ onOpen }: ProjectPickerProps) {
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [loading, setLoading] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    void trpc.project.listRecent.query()
      .then(setRecents)
      .catch((error) => {
        setErrorMessage(
          error instanceof Error ? error.message : 'Failed to load recent projects.',
        )
      })
  }, [])

  const handleOpenPath = async (projectPath: string) => {
    setErrorMessage(null)
    setLoading(true)
    try {
      const result = await trpc.project.open.mutate({ path: projectPath })
      onOpen(result)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to open project.',
      )
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (projectPath: string) => {
    setErrorMessage(null)
    setLoading(true)
    try {
      const result = await trpc.project.deleteRecent.mutate({ path: projectPath })
      setRecents(result.recents)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to delete recent project.',
      )
    } finally {
      setLoading(false)
    }
  }

  const handleBrowse = async () => {
    setErrorMessage(null)
    setLoading(true)
    try {
      const projectPath = await trpc.project.choose.mutate()
      if (!projectPath) {
        return
      }
      const result = await trpc.project.open.mutate({ path: projectPath })
      onOpen(result)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to browse project folder.',
      )
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    const name = projectName.trim()
    if (!name) {
      return
    }
    setErrorMessage(null)
    setLoading(true)
    try {
      const result = await trpc.project.create.mutate({ name })
      onOpen(result)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to create project.',
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[var(--surface-1)] via-[var(--surface-2)] to-[var(--surface-3)] text-foreground">
      <div className="mx-auto flex max-w-6xl flex-col gap-12 px-8 py-16">
        <Card className="border-border/60 bg-card/80 text-foreground shadow-2xl shadow-black/20 backdrop-blur">
          <CardContent className="flex flex-wrap items-center justify-between gap-10 p-10">
            <div className="max-w-2xl">
              <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
                DeepSearch Workspace
              </p>
              <h1 className="mt-3 text-3xl font-semibold text-foreground md:text-4xl">
                Choose a project directory
              </h1>
              <p className="mt-4 text-sm text-muted-foreground md:text-base">
                Your knowledge graph and source archives live inside the selected folder.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Project name"
                className="h-10 w-48 border-border/70 bg-background/70 text-sm text-foreground placeholder:text-muted-foreground"
              />
              <Button
                className="h-10 text-sm font-semibold shadow-sm"
                onClick={handleCreate}
                disabled={loading || !projectName.trim()}
              >
                {loading ? 'Creating...' : 'Create Project'}
              </Button>
              <Button
                variant="outline"
                className="h-10 border-border/70 bg-background/70 text-sm font-semibold hover:bg-accent"
                onClick={handleBrowse}
                disabled={loading}
              >
                {loading ? 'Opening...' : 'Browse Folder'}
              </Button>
            </div>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-4">
          {errorMessage ? (
            <Card className="border-destructive/40 bg-destructive/5 text-destructive">
              <CardContent className="p-4 text-sm">
                {errorMessage}
              </CardContent>
            </Card>
          ) : null}
          <div className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
            Recent projects
          </div>
          {recents.length === 0 ? (
            <Card className="border-dashed border-border/60 bg-card/60 text-muted-foreground">
              <CardContent className="p-6 text-sm">No recent projects yet.</CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {recents.map((project) => (
                <Card
                  key={project.path}
                  className="border-border/70 bg-card/80 text-left text-foreground shadow-lg shadow-black/20"
                >
                  <CardContent className="flex h-full flex-col gap-3 p-5">
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start p-0 text-left hover:bg-transparent"
                      onClick={() => handleOpenPath(project.path)}
                      disabled={loading}
                    >
                      <div>
                        <div className="text-lg font-semibold">{project.name}</div>
                        <div className="text-xs text-muted-foreground">{project.path}</div>
                        <div className="text-xs text-muted-foreground/70">
                          {new Date(project.lastOpened).toLocaleString()}
                        </div>
                      </div>
                    </Button>
                    <div className="mt-auto flex items-center justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-destructive/40 text-[0.65rem] uppercase tracking-[0.2em] text-destructive hover:bg-destructive/10"
                        onClick={() => handleDelete(project.path)}
                        disabled={loading}
                      >
                        Delete
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
