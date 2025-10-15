'use client';

import { useState, useRef } from 'react';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QuickAddProps {
  onEntryCreated?: () => void;
}

export function QuickAdd({ onEntryCreated }: QuickAddProps) {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!content.trim()) {
      setError('Please enter some content');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/entries', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: content.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create entry');
      }

      setContent('');
      onEntryCreated?.();
    } catch (err) {
      setError('Failed to save entry. Please try again.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      // TODO: Implement file upload
      setError('File upload coming soon! For now, you can paste text.');
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      // TODO: Implement file upload
      setError('File upload coming soon! For now, you can paste text.');
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div
        className={cn(
          'relative rounded-lg border-2 border-dashed transition-all',
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-border bg-card',
          'hover:border-primary/50'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What's on your mind? Type or drag files here..."
          rows={6}
          disabled={isLoading}
          className={cn(
            'border-0 bg-transparent text-lg resize-none focus-visible:ring-0 focus-visible:ring-offset-0',
            'placeholder:text-muted-foreground/60'
          )}
          aria-invalid={!!error}
        />

        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-primary/5 rounded-lg pointer-events-none">
            <div className="text-center">
              <Upload className="h-12 w-12 mx-auto mb-2 text-primary" />
              <p className="text-sm font-medium text-primary">Drop files here</p>
            </div>
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive mt-2">{error}</p>
      )}

      <div className="flex justify-end mt-4 gap-2">
        {content.trim() && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setContent('')}
            disabled={isLoading}
          >
            Clear
          </Button>
        )}
        <Button
          type="submit"
          disabled={isLoading || !content.trim()}
          size="lg"
        >
          {isLoading ? 'Saving...' : 'Capture'}
        </Button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileSelect}
        multiple
      />
    </form>
  );
}
