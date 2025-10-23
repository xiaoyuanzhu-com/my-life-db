'use client';

import { useState, useEffect, useMemo } from 'react';
import { EntryCard } from '@/components/EntryCard';
import { Card, CardContent } from '@/components/ui/card';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import type { Entry } from '@/types';

interface GroupedEntries {
  date: string;
  displayDate: string;
  entries: Entry[];
}

export default function InboxPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
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

    loadEntries();
  }, []);

  // Group entries by date
  const groupedEntries = useMemo(() => {
    const groups = new Map<string, Entry[]>();

    entries.forEach((entry) => {
      const dateKey = entry.date; // Format: YYYY-MM-DD
      if (!groups.has(dateKey)) {
        groups.set(dateKey, []);
      }
      groups.get(dateKey)!.push(entry);
    });

    // Convert to array and sort by date (newest first)
    const result: GroupedEntries[] = Array.from(groups.entries())
      .map(([date, entries]) => {
        const parsedDate = parseISO(date);
        let displayDate: string;

        if (isToday(parsedDate)) {
          displayDate = 'Today';
        } else if (isYesterday(parsedDate)) {
          displayDate = 'Yesterday';
        } else {
          displayDate = format(parsedDate, 'EEEE, MMMM d, yyyy');
        }

        return {
          date,
          displayDate,
          entries: entries.sort((a, b) =>
            new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime()
          ),
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    return result;
  }, [entries]);

  async function handleDelete(entryId: string) {
    if (!confirm('Are you sure you want to delete this entry?')) return;

    try {
      const response = await fetch(`/api/entries/${entryId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        // Reload entries
        const entriesResponse = await fetch('/api/entries?directory=inbox');
        const data = await entriesResponse.json();
        setEntries(data.entries);
      }
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Inbox</h1>
        </div>

        {/* Timeline */}
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        ) : entries.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">No entries in your inbox yet.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            {groupedEntries.map((group) => (
              <section key={group.date} className="space-y-4">
                {/* Sticky Date Header - sticks below global header */}
                <div className="sticky top-[73px] z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 py-3 border-b -mx-4 px-4">
                  <h2 className="text-xl font-semibold text-foreground">
                    {group.displayDate}
                  </h2>
                </div>

                {/* Entry Grid for this date */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {group.entries.map((entry) => (
                    <EntryCard
                      key={entry.metadata.id}
                      entry={entry}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
