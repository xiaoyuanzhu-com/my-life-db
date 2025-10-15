'use client';

import { useState, useEffect } from 'react';
import { QuickAdd } from '@/components/QuickAdd';
import { EntryCard } from '@/components/EntryCard';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import Link from 'next/link';
import type { Entry } from '@/types';

export default function InboxPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  async function loadEntries() {
    try {
      const response = await fetch('/api/entries?directory=inbox');
      const data = await response.json();
      setEntries(data.entries);
    } catch (error) {
      console.error('Failed to load entries:', error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadEntries();
  }, []);

  async function handleDelete(entryId: string) {
    if (!confirm('Are you sure you want to delete this entry?')) return;

    try {
      const response = await fetch(`/api/entries/${entryId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        await loadEntries();
      }
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Inbox</h1>
            <p className="text-muted-foreground mt-1">Your captured thoughts</p>
          </div>
          <Link
            href="/"
            className="text-primary hover:text-blue-700 text-sm font-medium"
          >
            ← Home
          </Link>
        </div>

        {/* Quick Add */}
        <Card>
          <CardHeader>
            <h2 className="text-xl font-semibold text-foreground">Quick Capture</h2>
          </CardHeader>
          <CardContent>
            <QuickAdd onEntryCreated={loadEntries} />
          </CardContent>
        </Card>

        {/* Entry List */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-foreground">
              All Entries ({entries.length})
            </h2>
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Loading...</div>
          ) : entries.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <p className="text-muted-foreground">No entries yet. Start capturing your thoughts above!</p>
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
