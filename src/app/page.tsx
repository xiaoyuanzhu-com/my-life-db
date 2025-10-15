'use client';

import { useState, useEffect } from 'react';
import { QuickAdd } from '@/components/QuickAdd';
import { EntryCard } from '@/components/EntryCard';
import { Card, CardHeader, CardContent, CardTitle } from '@/components/ui/card';
import Link from 'next/link';
import type { Entry } from '@/types';

export default function HomePage() {
  const [recentEntries, setRecentEntries] = useState<Entry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  async function loadRecentEntries() {
    try {
      const response = await fetch('/api/entries?directory=inbox');
      const data = await response.json();
      setRecentEntries(data.entries.slice(0, 5)); // Show only 5 most recent
    } catch (error) {
      console.error('Failed to load entries:', error);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadRecentEntries();
  }, []);

  async function handleDelete(entryId: string) {
    if (!confirm('Are you sure you want to delete this entry?')) return;

    try {
      const response = await fetch(`/api/entries/${entryId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        await loadRecentEntries();
      }
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl font-bold text-foreground">MyLifeDB</h1>
          <p className="text-muted-foreground">Capture your thoughts, organize your knowledge</p>
        </div>

        {/* Quick Add */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Capture</CardTitle>
          </CardHeader>
          <CardContent>
            <QuickAdd onEntryCreated={loadRecentEntries} />
          </CardContent>
        </Card>

        {/* Stats */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="text-center py-6">
              <div className="text-3xl font-bold text-primary">{recentEntries.length}</div>
              <div className="text-sm text-muted-foreground">Recent Entries</div>
            </CardContent>
          </Card>
          <Link href="/inbox">
            <Card className="transition-shadow hover:shadow-md">
              <CardContent className="text-center py-6">
                <div className="text-lg font-semibold text-foreground">View Inbox</div>
                <div className="text-sm text-muted-foreground">See all captures</div>
              </CardContent>
            </Card>
          </Link>
          <Link href="/library">
            <Card className="transition-shadow hover:shadow-md">
              <CardContent className="text-center py-6">
                <div className="text-lg font-semibold text-foreground">Browse Library</div>
                <div className="text-sm text-muted-foreground">Organized knowledge</div>
              </CardContent>
            </Card>
          </Link>
        </div>

        {/* Recent Entries */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-foreground">Recent Entries</h2>
            <Link href="/inbox" className="text-primary hover:text-primary/80 text-sm font-medium">
              View all →
            </Link>
          </div>

          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">Loading...</div>
          ) : recentEntries.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <p className="text-muted-foreground">No entries yet. Start capturing your thoughts above!</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {recentEntries.map((entry) => (
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
