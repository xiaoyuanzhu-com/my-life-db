'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Play, Pause, RefreshCw, Trash2 } from 'lucide-react';

interface TaskStats {
  total: number;
  'to-do': number;
  'in-progress': number;
  success: number;
  failed: number;
  pending_by_type?: Record<string, number>;
  has_ready_tasks?: boolean;
}

interface Task {
  id: string;
  type: string;
  status: 'to-do' | 'in-progress' | 'success' | 'failed';
  attempts: number;
  created_at: number;
  updated_at: number;
  error?: string | null;
}

interface WorkerStatus {
  running: boolean;
  paused: boolean;
}

export function TasksTab() {
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>({ running: false, paused: false });
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const fetchStats = async () => {
    try {
      const res = await fetch('/api/tasks/stats');
      const data = await res.json();
      setStats(data);
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  };

  const fetchTasks = async () => {
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (statusFilter !== 'all') {
        params.append('status', statusFilter);
      }
      const res = await fetch(`/api/tasks?${params}`);
      const data = await res.json();
      setTasks(data.tasks || []);
    } catch (error) {
      console.error('Failed to fetch tasks:', error);
    }
  };

  const fetchWorkerStatus = async () => {
    try {
      const res = await fetch('/api/tasks/worker/status');
      const data = await res.json();
      setWorkerStatus(data);
    } catch (error) {
      console.error('Failed to fetch worker status:', error);
    }
  };

  const pauseWorker = async () => {
    try {
      await fetch('/api/tasks/worker/pause', { method: 'POST' });
      await fetchWorkerStatus();
    } catch (error) {
      console.error('Failed to pause worker:', error);
    }
  };

  const resumeWorker = async () => {
    try {
      await fetch('/api/tasks/worker/resume', { method: 'POST' });
      await fetchWorkerStatus();
    } catch (error) {
      console.error('Failed to resume worker:', error);
    }
  };

  const deleteTask = async (id: string) => {
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      await fetchTasks();
      await fetchStats();
    } catch (error) {
      console.error('Failed to delete task:', error);
    }
  };

  const refreshData = async () => {
    setLoading(true);
    await Promise.all([fetchStats(), fetchTasks(), fetchWorkerStatus()]);
    setLoading(false);
  };

  useEffect(() => {
    refreshData();
    // Auto-refresh every 5 seconds
    const interval = setInterval(refreshData, 5000);
    return () => clearInterval(interval);
  }, [statusFilter]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const getStatusBadgeClass = (status: string) => {
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

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats?.total || 0}</div>
            <div className="text-sm text-muted-foreground">Total</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-blue-600">{stats?.['to-do'] || 0}</div>
            <div className="text-sm text-muted-foreground">To-Do</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-yellow-600">{stats?.['in-progress'] || 0}</div>
            <div className="text-sm text-muted-foreground">In Progress</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-green-600">{stats?.success || 0}</div>
            <div className="text-sm text-muted-foreground">Success</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold text-red-600">{stats?.failed || 0}</div>
            <div className="text-sm text-muted-foreground">Failed</div>
          </CardContent>
        </Card>
      </div>

      {/* Worker Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Worker Status</span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={refreshData}
                disabled={loading}
                className="gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              {workerStatus.paused ? (
                <Button size="sm" onClick={resumeWorker} className="gap-2">
                  <Play className="h-4 w-4" />
                  Resume Worker
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={pauseWorker} className="gap-2">
                  <Pause className="h-4 w-4" />
                  Pause Worker
                </Button>
              )}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <div
              className={`h-3 w-3 rounded-full ${
                workerStatus.running && !workerStatus.paused
                  ? 'bg-green-500'
                  : workerStatus.paused
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
              }`}
            />
            <span className="text-sm">
              {workerStatus.running && !workerStatus.paused
                ? 'Running'
                : workerStatus.paused
                ? 'Paused'
                : 'Stopped'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Tasks Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Recent Tasks</span>
            <div className="flex gap-2">
              <select
                className="px-3 py-1.5 text-sm rounded-md border bg-background"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All Status</option>
                <option value="to-do">To-Do</option>
                <option value="in-progress">In Progress</option>
                <option value="success">Success</option>
                <option value="failed">Failed</option>
              </select>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-2">Type</th>
                  <th className="text-left p-2">Status</th>
                  <th className="text-left p-2">Attempts</th>
                  <th className="text-left p-2">Created</th>
                  <th className="text-left p-2">Error</th>
                  <th className="text-right p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tasks.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center p-8 text-muted-foreground">
                      No tasks found
                    </td>
                  </tr>
                ) : (
                  tasks.map((task) => (
                    <tr key={task.id} className="border-b">
                      <td className="p-2 font-mono text-xs">{task.type}</td>
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
                      <td className="p-2 text-xs text-muted-foreground">
                        {formatDate(task.created_at)}
                      </td>
                      <td className="p-2 text-xs text-red-600 truncate max-w-[200px]">
                        {task.error || '-'}
                      </td>
                      <td className="p-2 text-right">
                        {(task.status === 'success' || task.status === 'failed') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deleteTask(task.id)}
                            className="h-8 w-8 p-0"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
