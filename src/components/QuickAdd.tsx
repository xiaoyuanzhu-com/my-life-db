'use client';

import { useState } from 'react';
import { Textarea } from './ui/Textarea';
import { Button } from './ui/Button';

interface QuickAddProps {
  onEntryCreated?: () => void;
}

export function QuickAdd({ onEntryCreated }: QuickAddProps) {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

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

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="space-y-3">
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What's on your mind? Start typing..."
          rows={4}
          error={error}
          disabled={isLoading}
          className="font-sans"
        />
        <div className="flex justify-end gap-2">
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
          >
            {isLoading ? 'Saving...' : 'Capture'}
          </Button>
        </div>
      </div>
    </form>
  );
}
