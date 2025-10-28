'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import type { InboxItem } from '@/types';

interface GroupedItems {
  date: string;
  displayDate: string;
  items: InboxItem[];
}

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadItems() {
      try {
        const response = await fetch('/api/inbox');
        const data = await response.json();
        setItems(data.items);
      } catch (error) {
        console.error('Failed to load inbox items:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadItems();
  }, []);

  // Group items by date based on client's local timezone
  const groupedItems = useMemo(() => {
    const groups = new Map<string, InboxItem[]>();

    items.forEach((item) => {
      const createdDate = new Date(item.createdAt);
      const dateKey = format(createdDate, 'yyyy-MM-dd');

      if (!groups.has(dateKey)) {
        groups.set(dateKey, []);
      }
      groups.get(dateKey)!.push(item);
    });

    // Convert to array and sort by date (newest first)
    const result: GroupedItems[] = Array.from(groups.entries())
      .map(([date, items]) => {
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
          items: items.sort((a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          ),
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    return result;
  }, [items]);

  async function handleDelete(itemId: string) {
    if (!confirm('Are you sure you want to delete this item?')) return;

    try {
      const response = await fetch(`/api/inbox/${itemId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        // Reload items
        const itemsResponse = await fetch('/api/inbox');
        const data = await itemsResponse.json();
        setItems(data.items);
      }
    } catch (error) {
      console.error('Failed to delete item:', error);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="px-[20%] py-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Inbox</h1>
        </div>

        {/* Timeline */}
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">No items in your inbox yet.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            {groupedItems.map((group) => (
              <section key={group.date} className="space-y-4">
                {/* Sticky Date Header - sticks below global header */}
                <div className="sticky top-[73px] z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 py-3 border-b">
                  <h2 className="text-xl font-semibold text-foreground">
                    {group.displayDate}
                  </h2>
                </div>

                {/* Item Grid for this date */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {group.items.map((item) => (
                    <Card key={item.id} className="overflow-hidden hover:shadow-lg transition-shadow">
                      <CardContent className="p-4">
                        {/* Item Type Badge */}
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-xs font-medium px-2 py-1 rounded-full bg-muted text-muted-foreground">
                            {item.type}
                          </span>
                          {item.status !== 'pending' && (
                            <span className={`text-xs font-medium px-2 py-1 rounded-full ${
                              item.status === 'completed' ? 'bg-green-100 text-green-700' :
                              item.status === 'processing' ? 'bg-blue-100 text-blue-700' :
                              'bg-red-100 text-red-700'
                            }`}>
                              {item.status}
                            </span>
                          )}
                        </div>

                        {/* Files List */}
                        <div className="space-y-2 mb-3">
                          {item.files.map((file, idx) => (
                            <div key={idx} className="flex items-center gap-2 text-sm">
                              <span className="text-muted-foreground">
                                {file.type === 'text' ? '📝' :
                                 file.type === 'image' ? '🖼️' :
                                 file.type === 'audio' ? '🎵' :
                                 file.type === 'video' ? '🎥' :
                                 file.type === 'pdf' ? '📄' : '📎'}
                              </span>
                              <span className="truncate">{file.filename}</span>
                              <span className="text-xs text-muted-foreground ml-auto">
                                {(file.size / 1024).toFixed(1)} KB
                              </span>
                            </div>
                          ))}
                        </div>

                        {/* Timestamp */}
                        <div className="text-xs text-muted-foreground mb-3">
                          {format(new Date(item.createdAt), 'h:mm a')}
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="text-xs text-red-600 hover:text-red-700 font-medium"
                          >
                            Delete
                          </button>
                        </div>
                      </CardContent>
                    </Card>
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
