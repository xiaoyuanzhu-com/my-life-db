'use client';

import { useState, useEffect, use } from 'react';
import { EntryCard } from '@/components/EntryCard';
import { Card, CardContent } from '@/components/ui/Card';
import Link from 'next/link';
import type { Entry, Directory } from '@/types';

export default function DirectoryDetailPage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = use(params);
  const dirPath = `library/${path.join('/')}`;

  const [entries, setEntries] = useState<Entry[]>([]);
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  async function loadDirectory() {
    try {
      const [dirResponse, entriesResponse] = await Promise.all([
        fetch(`/api/directories?path=${encodeURIComponent(dirPath)}`),
        fetch(`/api/entries?directory=${encodeURIComponent(dirPath)}`),
      ]);

      const dirData = await dirResponse.json();
      const entriesData = await entriesResponse.json();

      setDirectory(dirData);
      setEntries(entriesData.entries);
    } catch (error) {
      console.error('Failed to load directory:', error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadDirectory();
  }, [dirPath]);

  async function handleDelete(entryId: string) {
    if (!confirm('Are you sure you want to delete this entry?')) return;

    try {
      const response = await fetch(`/api/entries/${entryId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        await loadDirectory();
      }
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-warm-50 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!directory) {
    return (
      <div className="min-h-screen bg-warm-50 flex items-center justify-center">
        <Card>
          <CardContent className="text-center py-12">
            <p className="text-gray-600">Directory not found</p>
            <Link href="/library" className="text-amber-600 hover:text-amber-700 text-sm font-medium mt-4 inline-block">
              ← Back to Library
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-warm-50">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-4xl">{directory.metadata.icon || '📁'}</span>
              <h1 className="text-3xl font-bold text-gray-900">{directory.metadata.name}</h1>
            </div>
            {directory.metadata.description && (
              <p className="text-gray-600">{directory.metadata.description}</p>
            )}
          </div>
          <Link
            href="/library"
            className="text-amber-600 hover:text-amber-700 text-sm font-medium"
          >
            ← Library
          </Link>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="text-center py-6">
              <div className="text-2xl font-bold text-amber-600">{entries.length}</div>
              <div className="text-sm text-gray-600">Entries</div>
            </CardContent>
          </Card>
          {directory.subdirectories.length > 0 && (
            <Card>
              <CardContent className="text-center py-6">
                <div className="text-2xl font-bold text-amber-600">{directory.subdirectories.length}</div>
                <div className="text-sm text-gray-600">Subdirectories</div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Subdirectories */}
        {directory.subdirectories.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Subdirectories</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {directory.subdirectories.map((subdir) => (
                <Link
                  key={subdir}
                  href={`/library/${path.join('/')}/${subdir}`}
                >
                  <Card hover>
                    <CardContent className="py-4">
                      <div className="flex items-center gap-2">
                        <span className="text-2xl">📁</span>
                        <span className="font-medium text-gray-900">{subdir}</span>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Entries */}
        <div>
          <h2 className="text-xl font-semibold text-gray-900 mb-4">
            Entries ({entries.length})
          </h2>

          {entries.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <p className="text-gray-600">
                  No entries in this directory yet. Move entries from your Inbox to organize them here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {entries.map((entry) => (
                <EntryCard
                  key={entry.metadata.id}
                  entry={entry}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
