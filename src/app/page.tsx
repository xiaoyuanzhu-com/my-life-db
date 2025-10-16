'use client';

import { useState, useEffect } from 'react';
import { QuickAdd } from '@/components/QuickAdd';
import { EntryCard } from '@/components/EntryCard';
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

  async function handleProcess(entryId: string) {
    try {
      const response = await fetch(`/api/entries/${entryId}/process`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          includeEntities: true,
          includeSentiment: true,
          includeActionItems: true,
          includeRelatedEntries: false,
        }),
      });

      if (response.ok) {
        await loadRecentEntries();
      } else {
        console.error('Failed to process entry');
      }
    } catch (error) {
      console.error('Failed to process entry:', error);
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Centered Input Section */}
      <div className="flex-1 flex items-center justify-center px-4 py-12 md:py-20">
        <div className="w-full max-w-3xl">
          <QuickAdd onEntryCreated={loadRecentEntries} />
        </div>
      </div>

      {/* Recent Entries Section */}
      <div className="border-t bg-muted/30">
        <div className="max-w-5xl mx-auto px-4 py-12">
          <div className="space-y-6">
            <h2 className="text-2xl font-semibold text-foreground">Recent Captures</h2>

            {isLoading ? (
              <div className="text-center py-12 text-muted-foreground">Loading...</div>
            ) : recentEntries.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">No entries yet. Start capturing your thoughts above!</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {recentEntries.map((entry) => (
                  <EntryCard
                    key={entry.metadata.id}
                    entry={entry}
                    onDelete={handleDelete}
                    onProcess={handleProcess}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
