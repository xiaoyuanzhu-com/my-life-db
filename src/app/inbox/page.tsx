'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { format } from 'date-fns';
import type { InboxItem } from '@/types';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"

type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface QueueState {
  currentPage: number;
}

const ITEMS_PER_PAGE = 10;

export default function InboxPage() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [queuePages, setQueuePages] = useState<Record<ProcessingStatus, number>>({
    pending: 1,
    processing: 1,
    completed: 1,
    failed: 1,
  });

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

  // Group items by status
  const queuedItems = useMemo(() => {
    const queues: Record<ProcessingStatus, InboxItem[]> = {
      pending: [],
      processing: [],
      completed: [],
      failed: [],
    };

    items.forEach((item) => {
      queues[item.status].push(item);
    });

    // Sort each queue by creation time (newest first)
    Object.keys(queues).forEach((status) => {
      queues[status as ProcessingStatus].sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    });

    return queues;
  }, [items]);

  const getQueueConfig = (status: ProcessingStatus) => {
    const configs = {
      pending: {
        label: 'Pending Queue',
        color: 'text-yellow-600 dark:text-yellow-500',
        bgColor: 'bg-yellow-100 dark:bg-yellow-900/20',
      },
      processing: {
        label: 'Processing Queue',
        color: 'text-blue-600 dark:text-blue-500',
        bgColor: 'bg-blue-100 dark:bg-blue-900/20',
      },
      completed: {
        label: 'Completed Queue',
        color: 'text-green-600 dark:text-green-500',
        bgColor: 'bg-green-100 dark:bg-green-900/20',
      },
      failed: {
        label: 'Failed Queue',
        color: 'text-red-600 dark:text-red-500',
        bgColor: 'bg-red-100 dark:bg-red-900/20',
      },
    };
    return configs[status];
  };

  const getPaginatedItems = (status: ProcessingStatus) => {
    const items = queuedItems[status];
    const currentPage = queuePages[status];
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    return items.slice(startIndex, endIndex);
  };

  const getTotalPages = (status: ProcessingStatus) => {
    return Math.ceil(queuedItems[status].length / ITEMS_PER_PAGE);
  };

  const handlePageChange = (status: ProcessingStatus, page: number) => {
    setQueuePages(prev => ({ ...prev, [status]: page }));
  };

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

  const renderQueue = (status: ProcessingStatus) => {
    const config = getQueueConfig(status);
    const queueItems = queuedItems[status];
    const paginatedItems = getPaginatedItems(status);
    const totalPages = getTotalPages(status);
    const currentPage = queuePages[status];

    return (
      <AccordionItem value={status} key={status}>
        <AccordionTrigger className="hover:no-underline">
          <div className="flex items-center gap-3 w-full">
            <span className="text-lg font-semibold">{config.label}</span>
            <span className={`text-sm font-medium px-3 py-1 rounded-full ${config.bgColor} ${config.color}`}>
              {queueItems.length} {queueItems.length === 1 ? 'item' : 'items'}
            </span>
          </div>
        </AccordionTrigger>
        <AccordionContent>
          {queueItems.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4">No items in this queue.</p>
          ) : (
            <div className="space-y-4">
              {/* Items List */}
              <div className="space-y-3">
                {paginatedItems.map((item) => (
                  <Card key={item.id} className="overflow-hidden">
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <CardTitle className="text-base font-medium">
                            {item.folderName}
                          </CardTitle>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium px-2 py-1 rounded-full bg-muted text-muted-foreground">
                              {item.type}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(item.createdAt), 'MMM d, yyyy h:mm a')}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleDelete(item.id)}
                          className="text-xs text-red-600 hover:text-red-700 font-medium"
                        >
                          Delete
                        </button>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {/* Files List */}
                      {item.files.length > 0 && (
                        <div className="space-y-2">
                          <h4 className="text-xs font-semibold text-muted-foreground uppercase">Files</h4>
                          <div className="space-y-1.5">
                            {item.files.map((file, idx) => (
                              <div key={idx} className="flex items-center gap-2 text-sm p-2 rounded bg-muted/50">
                                <span className="text-muted-foreground shrink-0">
                                  {file.type === 'text' ? '📝' :
                                   file.type === 'image' ? '🖼️' :
                                   file.type === 'audio' ? '🎵' :
                                   file.type === 'video' ? '🎥' :
                                   file.type === 'pdf' ? '📄' : '📎'}
                                </span>
                                <span className="truncate flex-1">{file.filename}</span>
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {(file.size / 1024).toFixed(1)} KB
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Additional Details */}
                      <div className="grid grid-cols-2 gap-3 text-xs">
                        {item.processedAt && (
                          <div>
                            <span className="text-muted-foreground">Processed:</span>
                            <span className="ml-1 font-medium">
                              {format(new Date(item.processedAt), 'MMM d, h:mm a')}
                            </span>
                          </div>
                        )}
                        {item.aiSlug && (
                          <div>
                            <span className="text-muted-foreground">AI Slug:</span>
                            <span className="ml-1 font-medium">{item.aiSlug}</span>
                          </div>
                        )}
                        {item.error && (
                          <div className="col-span-2">
                            <span className="text-muted-foreground">Error:</span>
                            <span className="ml-1 text-red-600">{item.error}</span>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        onClick={() => handlePageChange(status, Math.max(1, currentPage - 1))}
                        className={currentPage === 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                      />
                    </PaginationItem>
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                      <PaginationItem key={page}>
                        <PaginationLink
                          onClick={() => handlePageChange(status, page)}
                          isActive={currentPage === page}
                          className="cursor-pointer"
                        >
                          {page}
                        </PaginationLink>
                      </PaginationItem>
                    ))}
                    <PaginationItem>
                      <PaginationNext
                        onClick={() => handlePageChange(status, Math.min(totalPages, currentPage + 1))}
                        className={currentPage === totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              )}
            </div>
          )}
        </AccordionContent>
      </AccordionItem>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="px-[20%] py-8">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Task Queue</h1>
          <p className="text-muted-foreground mt-2">
            Manage your inbox items organized by processing status
          </p>
        </div>

        {/* Queue List */}
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        ) : items.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">No items in your inbox yet.</p>
            </CardContent>
          </Card>
        ) : (
          <Accordion type="multiple" className="space-y-4">
            {renderQueue('pending')}
            {renderQueue('processing')}
            {renderQueue('completed')}
            {renderQueue('failed')}
          </Accordion>
        )}
      </div>
    </div>
  );
}
