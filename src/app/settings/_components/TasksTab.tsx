'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Trash2, ChevronDown, ChevronRight } from 'lucide-react';

type TaskStatus = 'to-do' | 'in-progress' | 'success' | 'failed';

interface TaskStats {
  total: number;
  by_status: Record<TaskStatus, number>;
  by_type: Record<string, number>;
  pending_by_type?: Record<string, number>;
  has_ready_tasks?: boolean;
}

interface Task {
  id: string;
  type: string;
  status: TaskStatus;
  attempts: number;
  created_at: number;
  updated_at: number;
  error?: string | null;
  // Optional fields available from API (DB columns)
  input?: string;
  output?: string | null;
  version?: number;
  last_attempt_at?: number | null;
  run_after?: number | null;
  completed_at?: number | null;
}

export function TasksTab() {
  const [stats, setStats] = useState<TaskStats | null>(null);

  // Per-queue expand + data
  const [openTypes, setOpenTypes] = useState<Record<string, boolean>>({});
  const [tasksByType, setTasksByType] = useState<Record<string, Task[]>>({});
  const [loadingType, setLoadingType] = useState<Record<string, boolean>>({});
  const [openTaskRows, setOpenTaskRows] = useState<Record<string, Record<string, boolean>>>({});

  const types = useMemo(() => {
    if (!stats) return [] as string[];
    const entries = Object.keys(stats.by_type || {});
    // Sort by pending desc then alphabetically
    return entries.sort((a, b) => {
      const pa = stats.pending_by_type?.[a] || 0;
      const pb = stats.pending_by_type?.[b] || 0;
      if (pb !== pa) return pb - pa;
      return a.localeCompare(b);
    });
  }, [stats]);

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/tasks/stats');
      const data = (await res.json()) as TaskStats;
      setStats(data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  };

  const fetchTasksForType = async (type: string) => {
    try {
      setLoadingType((prev) => ({ ...prev, [type]: true }));
      const params = new URLSearchParams({ limit: '20', type });
      const res = await fetch(`/api/tasks?${params}`);
      const data = (await res.json()) as { tasks: Task[] };
      setTasksByType((prev) => ({ ...prev, [type]: data.tasks || [] }));
    } catch (error) {
      console.error('Failed to fetch tasks for type:', type, error);
    } finally {
      setLoadingType((prev) => ({ ...prev, [type]: false }));
    }
  };

  // Worker controls removed (list-only view)

  const deleteTask = async (id: string, type: string) => {
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      await Promise.all([fetchStats(), fetchTasksForType(type)]);
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const toggleType = async (type: string) => {
    setOpenTypes((prev) => ({ ...prev, [type]: !prev[type] }));
    const willOpen = !openTypes[type];
    if (willOpen) {
      await fetchTasksForType(type);
    }
  };

  const toggleTaskRow = (type: string, id: string) => {
    setOpenTaskRows((prev) => ({
      ...prev,
      [type]: { ...prev[type], [id]: !prev[type]?.[id] },
    }));
  };

  const refreshData = async () => {
    await Promise.all([fetchStats()]);
    const open = Object.keys(openTypes).filter((t) => openTypes[t]);
    if (open.length > 0) {
      await Promise.all(open.map((t) => fetchTasksForType(t)));
    }
  };

  useEffect(() => {
    // Initial load + auto-refresh
    refreshData();
    const interval = setInterval(() => {
      refreshData();
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // No status filter: nothing to observe here

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const getStatusBadgeClass = (status: TaskStatus) => {
    switch (status) {
      case 'to-do':
        return 'bg-blue-100 text-blue-800';
      case 'in-progress':
        return 'bg-yellow-100 text-yellow-800';
      case 'success':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const parseJson = (s?: string | null) => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Task Queues</h2>
      {types.length === 0 ? (
        <div className="text-sm text-muted-foreground">No task types yet</div>
      ) : (
        <div className="space-y-1">
          {types.map((type) => {
            const total = stats?.by_type?.[type] || 0;
            const pending = stats?.pending_by_type?.[type] || 0;
            const isOpen = !!openTypes[type];
            return (
              <div key={type}>
                <button
                  type="button"
                  onClick={() => toggleType(type)}
                  className="w-full flex items-center justify-between px-2 py-2 hover:bg-accent rounded-md"
                >
                  <div className="flex items-center gap-2">
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                    <code className="text-xs px-1.5 py-0.5 rounded bg-muted">{type}</code>
                    <span className="text-xs text-muted-foreground">{total} total</span>
                    {pending > 0 && (
                      <span className="text-xs text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">
                        {pending} pending
                      </span>
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="px-2 pb-2">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr>
                            <th className="text-left p-2">Status</th>
                            <th className="text-left p-2">Attempts</th>
                            <th className="text-left p-2">Created</th>
                            <th className="text-left p-2">Error</th>
                            <th className="text-right p-2">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {loadingType[type] ? (
                            <tr>
                              <td colSpan={5} className="p-6 text-center text-muted-foreground">
                                Loading...
                              </td>
                            </tr>
                          ) : (tasksByType[type] || []).length === 0 ? (
                            <tr>
                              <td colSpan={5} className="p-6 text-center text-muted-foreground">
                                No recent tasks
                              </td>
                            </tr>
                          ) : (
                            (tasksByType[type] || []).map((task) => {
                              const rowOpen = !!openTaskRows[type]?.[task.id];
                              const inputVal = parseJson(task.input);
                              const outputVal = parseJson(task.output);
                              return (
                                <Fragment key={task.id}>
                                  <tr
                                    className="hover:bg-accent cursor-pointer"
                                    onClick={() => toggleTaskRow(type, task.id)}
                                    title="Click to view details"
                                  >
                                    <td className="p-2">
                                      <span
                                        className={`inline-block px-2 py-1 rounded text-xs font-medium ${getStatusBadgeClass(
                                          task.status
                                        )}`}
                                      >
                                        {task.status}
                                      </span>
                                    </td>
                                    <td className="p-2">{task.attempts}</td>
                                    <td className="p-2 text-xs text-muted-foreground">{formatDate(task.created_at)}</td>
                                    <td className="p-2 text-xs text-red-600 truncate max-w-[280px]">
                                      {task.error || '-'}
                                    </td>
                                    <td className="p-2 text-right">
                                      {(task.status === 'success' || task.status === 'failed') && (
                                        <Button
                                          size="sm"
                                          variant="ghost"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            deleteTask(task.id, type);
                                          }}
                                          className="h-8 w-8 p-0"
                                          title="Delete task"
                                        >
                                          <Trash2 className="h-4 w-4" />
                                        </Button>
                                      )}
                                    </td>
                                  </tr>
                                  {rowOpen && (
                                    <tr>
                                      <td colSpan={5} className="p-3 bg-muted/50">
                                        <div className="rounded-md bg-background p-3">
                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div className="space-y-1 text-xs">
                                              <div>
                                                <span className="text-muted-foreground">ID:</span>{' '}
                                                <code className="break-all">{task.id}</code>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Type:</span>{' '}
                                                <code>{task.type}</code>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Version:</span>{' '}
                                                <code>{task.version ?? '-'}</code>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Attempts:</span>{' '}
                                                <code>{task.attempts}</code>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Status:</span>{' '}
                                                <code>{task.status}</code>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Created:</span>{' '}
                                                <span>{formatDate(task.created_at)}</span>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Updated:</span>{' '}
                                                <span>{formatDate(task.updated_at)}</span>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Last attempt:</span>{' '}
                                                <span>{task.last_attempt_at ? formatDate(task.last_attempt_at) : '-'}</span>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Run after:</span>{' '}
                                                <span>{task.run_after ? formatDate(task.run_after) : '-'}</span>
                                              </div>
                                              <div>
                                                <span className="text-muted-foreground">Completed:</span>{' '}
                                                <span>{task.completed_at ? formatDate(task.completed_at) : '-'}</span>
                                              </div>
                                              {task.error && (
                                                <div className="mt-2 text-red-700">
                                                  <div className="text-muted-foreground">Error:</div>
                                                  <pre className="whitespace-pre-wrap break-words font-mono bg-red-50 p-2 rounded">
                                                    {task.error}
                                                  </pre>
                                                </div>
                                              )}
                                            </div>
                                            <div className="space-y-3">
                                              <div>
                                                <div className="text-xs text-muted-foreground">Input</div>
                                                <pre className="text-xs whitespace-pre-wrap break-words font-mono bg-muted p-2 rounded">
                                                  {inputVal != null
                                                    ? typeof inputVal === 'string'
                                                      ? inputVal
                                                      : JSON.stringify(inputVal, null, 2)
                                                    : '-'}
                                                </pre>
                                              </div>
                                              <div>
                                                <div className="text-xs text-muted-foreground">Output</div>
                                                <pre className="text-xs whitespace-pre-wrap break-words font-mono bg-muted p-2 rounded">
                                                  {outputVal != null
                                                    ? typeof outputVal === 'string'
                                                      ? outputVal
                                                      : JSON.stringify(outputVal, null, 2)
                                                    : '-'}
                                                </pre>
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
