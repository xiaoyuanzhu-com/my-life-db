'use client';

import { useState, useEffect } from 'react';
import { DirectoryCard } from '@/components/DirectoryCard';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Link from 'next/link';
import type { Directory } from '@/types';

export default function LibraryPage() {
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [newDirDescription, setNewDirDescription] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  async function loadDirectories() {
    try {
      const response = await fetch('/api/directories?parent=library');
      const data = await response.json();
      setDirectories(data.directories);
    } catch (error) {
      console.error('Failed to load directories:', error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadDirectories();
  }, []);

  async function handleCreateDirectory(e: React.FormEvent) {
    e.preventDefault();

    if (!newDirName.trim()) return;

    setIsCreating(true);

    try {
      const response = await fetch('/api/directories', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: newDirName.trim(),
          description: newDirDescription.trim() || undefined,
          parentPath: 'library',
        }),
      });

      if (response.ok) {
        setNewDirName('');
        setNewDirDescription('');
        setShowCreateForm(false);
        await loadDirectories();
      }
    } catch (error) {
      console.error('Failed to create directory:', error);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Library</h1>
            <p className="text-muted-foreground mt-1">Your organized knowledge</p>
          </div>
          <Link
            href="/"
            className="text-primary hover:text-amber-700 text-sm font-medium"
          >
            ← Home
          </Link>
        </div>

        {/* Create Directory Button */}
        <div>
          {!showCreateForm ? (
            <Button onClick={() => setShowCreateForm(true)}>
              + New Directory
            </Button>
          ) : (
            <Card>
              <CardContent>
                <form onSubmit={handleCreateDirectory} className="space-y-4">
                  <h3 className="text-lg font-semibold text-foreground">Create New Directory</h3>
                  <div>
                    <label className="text-sm font-medium mb-2 block">Name</label>
                    <Input
                      value={newDirName}
                      onChange={(e) => setNewDirName(e.target.value)}
                      placeholder="e.g., Work Projects, Personal Notes"
                      disabled={isCreating}
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-2 block">Description (optional)</label>
                    <Input
                      value={newDirDescription}
                      onChange={(e) => setNewDirDescription(e.target.value)}
                      placeholder="What will you store here?"
                      disabled={isCreating}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={isCreating || !newDirName.trim()}>
                      {isCreating ? 'Creating...' : 'Create'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setShowCreateForm(false);
                        setNewDirName('');
                        setNewDirDescription('');
                      }}
                      disabled={isCreating}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Directory List */}
        <div>
          <h2 className="text-xl font-semibold text-foreground mb-4">
            Directories ({directories.length})
          </h2>

          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Loading...</div>
          ) : directories.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <p className="text-muted-foreground">
                  No directories yet. Create your first directory to start organizing!
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {directories.map((directory) => (
                <DirectoryCard
                  key={directory.path}
                  directory={directory}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
