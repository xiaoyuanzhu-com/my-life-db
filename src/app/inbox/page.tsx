'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { format, isToday, isYesterday, parseISO } from 'date-fns';
import type { InboxItem, InboxEnrichmentSummary, InboxDigestScreenshot } from '@/types';
import { InboxItemCard } from './_components/InboxItemCard';

interface GroupedItems {
  date: string;
  displayDate: string;
  items: InboxListItem[];
}

type InboxListItem = InboxItem & {
  path?: string; // File path from file-centric model
  enrichment: InboxEnrichmentSummary;
  primaryText: string | null;
  digestScreenshot: InboxDigestScreenshot | null;
};

export default function InboxPage() {
  const [items, setItems] = useState<InboxListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadItems() {
      try {
        const response = await fetch('/api/inbox');
        const data = await response.json();
        setItems(data.items as InboxListItem[]);
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
    const groups = new Map<string, InboxListItem[]>();

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

  // Actions and processing controls removed for a text-focused view

  // Simplified UI: show text content preview only

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
                  {group.items.map((item) => {
                    // Extract the relative path part after 'inbox/'
                    const pathSegment = item.path?.replace('inbox/', '') || item.folderName;
                    return (
                      <Link key={item.path || item.id} href={`/inbox/${encodeURIComponent(pathSegment)}`} className="group block">
                        <InboxItemCard item={item} />
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
