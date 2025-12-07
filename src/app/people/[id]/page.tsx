'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ArrowLeft, User, Volume2, Camera, Trash2, GitMerge, MoreHorizontal, X, Check } from 'lucide-react';
import type { PeopleRecord, PeopleCluster, VoiceSourceOffset } from '@/types/models';
import { use } from 'react';
import { VoiceClipList } from '@/components/voice-clip-list';

interface VoiceSegmentWithText {
  start: number;
  end: number;
  text: string;
}

interface PeopleEmbeddingDisplay {
  id: string;
  clusterId: string | null;
  type: 'voice' | 'face';
  sourcePath: string;
  sourceOffset: VoiceSourceOffset | null;
  quality: number | null;
  manualAssignment: boolean;
  createdAt: string;
  segmentsWithText?: VoiceSegmentWithText[];
}

interface PeopleDetail extends PeopleRecord {
  clusters: {
    voice: PeopleCluster[];
    face: PeopleCluster[];
  };
  embeddings: {
    voice: PeopleEmbeddingDisplay[];
    face: PeopleEmbeddingDisplay[];
  };
}

// Fuzzy match: checks if all characters in query appear in target in order
// e.g., "zh" matches "zhao", "zo" matches "zhao"
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
    }
  }
  return qi === q.length;
}

export default function PeopleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [people, setPeople] = useState<PeopleDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [existingPeople, setExistingPeople] = useState<{ id: string; displayName: string }[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  const [mergeTargetName, setMergeTargetName] = useState<string>('');

  const loadPeople = useCallback(async () => {
    try {
      const response = await fetch(`/api/people/${id}`);
      if (response.ok) {
        const data = await response.json();
        setPeople(data);
        setEditName(data.displayName || '');
      } else if (response.status === 404) {
        setPeople(null);
      }
    } catch (error) {
      console.error('Failed to load people:', error);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadPeople();
  }, [loadPeople]);

  // Load existing people when entering edit mode
  useEffect(() => {
    if (isEditing) {
      fetch('/api/people?limit=1000')
        .then((res) => res.json())
        .then((data) => {
          const peopleList = data.people
            ?.filter((p: { id: string; displayName: string | null }) => p.displayName && p.id !== id)
            .map((p: { id: string; displayName: string }) => ({ id: p.id, displayName: p.displayName })) || [];
          setExistingPeople(peopleList);
        })
        .catch(console.error);
    }
  }, [isEditing, id]);

  const handleSaveName = async () => {
    if (!people || !editName.trim()) return;

    // Check if name matches an existing person
    const matchingPerson = existingPeople.find(
      (p) => p.displayName.toLowerCase() === editName.trim().toLowerCase()
    );

    if (matchingPerson) {
      // Show merge confirmation
      setMergeTargetId(matchingPerson.id);
      setMergeTargetName(matchingPerson.displayName);
      return;
    }

    await saveNameDirectly();
  };

  const saveNameDirectly = async () => {
    if (!people || !editName.trim()) return;

    setIsSaving(true);
    try {
      const response = await fetch(`/api/people/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: editName.trim() }),
      });

      if (response.ok) {
        const updated = await response.json();
        setPeople((prev) => (prev ? { ...prev, ...updated } : null));
        setIsEditing(false);
        setShowSuggestions(false);
      }
    } catch (error) {
      console.error('Failed to save name:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleMerge = async () => {
    if (!mergeTargetId) return;

    setIsSaving(true);
    try {
      // Merge current person into the target (existing person with that name)
      const response = await fetch(`/api/people/${mergeTargetId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: id }),
      });

      if (response.ok) {
        // Redirect to the merged person's page
        router.push(`/people/${mergeTargetId}`);
      }
    } catch (error) {
      console.error('Failed to merge:', error);
    } finally {
      setIsSaving(false);
      setMergeTargetId(null);
      setMergeTargetName('');
    }
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setShowSuggestions(false);
    setEditName(people?.displayName || '');
  };

  const handleDelete = async () => {
    try {
      const response = await fetch(`/api/people/${id}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        router.push('/people');
      }
    } catch (error) {
      console.error('Failed to delete people:', error);
    }
  };

  const handleUnassignEmbedding = async (embeddingId: string) => {
    try {
      const response = await fetch(`/api/people/embeddings/${embeddingId}/unassign`, {
        method: 'POST',
      });

      if (response.ok) {
        // Reload people data
        loadPeople();
      }
    } catch (error) {
      console.error('Failed to unassign embedding:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="px-[20%] py-8">
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        </div>
      </div>
    );
  }

  if (!people) {
    return (
      <div className="min-h-screen bg-background">
        <div className="px-[20%] py-8">
          <Card>
            <CardContent className="text-center py-12">
              <User className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-4">People not found</p>
              <Link href="/people">
                <Button variant="outline">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to People
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="px-[20%] py-8">
        {/* Back link */}
        <Link href="/people" className="inline-flex items-center text-muted-foreground hover:text-foreground mb-6">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to People
        </Link>

        {/* Header */}
        <div className="flex items-start gap-6 mb-8">
          {/* Avatar */}
          <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
            {people.avatar ? (
              <img
                src={`data:image/jpeg;base64,${people.avatar}`}
                alt={people.displayName || 'People'}
                className="w-full h-full object-cover"
              />
            ) : people.clusters.face.length > 0 ? (
              <Camera className="h-12 w-12 text-muted-foreground" />
            ) : people.clusters.voice.length > 0 ? (
              <Volume2 className="h-12 w-12 text-muted-foreground" />
            ) : (
              <User className="h-12 w-12 text-muted-foreground" />
            )}
          </div>

          {/* Name and actions */}
          <div className="flex-1">
            {isEditing ? (
              <div className="relative">
                <div className="flex items-center">
                  <Input
                    value={editName}
                    onChange={(e) => {
                      setEditName(e.target.value);
                      setShowSuggestions(true);
                    }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => {
                      // Delay to allow click on suggestions
                      setTimeout(() => {
                        cancelEdit();
                      }, 150);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSaveName();
                      } else if (e.key === 'Escape') {
                        cancelEdit();
                      }
                    }}
                    placeholder="Enter name"
                    className="text-2xl font-bold h-12 pr-12"
                    autoFocus
                  />
                  <Button
                    onClick={handleSaveName}
                    disabled={isSaving || !editName.trim()}
                    size="icon"
                    className="absolute right-1 h-10 w-10"
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                </div>
                {/* Autocomplete suggestions */}
                {showSuggestions && editName.trim() && (() => {
                  const filtered = existingPeople
                    .filter((p) => fuzzyMatch(editName.trim(), p.displayName))
                    .slice(0, 10);

                  if (filtered.length === 0) return null;

                  return (
                    <div className="absolute top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg z-10 max-h-60 overflow-auto">
                      {filtered.map((p) => (
                        <div
                          key={p.id}
                          className="px-3 py-2 hover:bg-accent cursor-pointer text-sm"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setEditName(p.displayName);
                            setShowSuggestions(false);
                          }}
                        >
                          {p.displayName}
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            ) : (
              <h1
                className={`text-3xl font-bold cursor-pointer hover:text-muted-foreground transition-colors ${people.isPending ? 'text-muted-foreground italic' : 'text-foreground'}`}
                onClick={() => setIsEditing(true)}
                title="Click to edit name"
              >
                {people.displayName || 'Click to add name'}
              </h1>
            )}

            {/* Merge confirmation dialog */}
            <AlertDialog open={!!mergeTargetId} onOpenChange={(open) => !open && setMergeTargetId(null)}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Merge with existing person?</AlertDialogTitle>
                  <AlertDialogDescription>
                    &quot;{mergeTargetName}&quot; already exists. Do you want to merge this person into them?
                    All voice clips and faces will be moved to {mergeTargetName}.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setMergeTargetId(null)}>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleMerge}>Merge</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <p className="text-muted-foreground mt-2">
              {people.clusters.voice.length} voice cluster{people.clusters.voice.length !== 1 ? 's' : ''}
              {people.clusters.face.length > 0 && (
                <> &middot; {people.clusters.face.length} face cluster{people.clusters.face.length !== 1 ? 's' : ''}</>
              )}
            </p>

            {/* Actions */}
            <div className="flex items-center gap-2 mt-4">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <MoreHorizontal className="h-4 w-4 mr-2" />
                    Actions
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuItem onClick={() => {/* TODO: Implement merge UI */}}>
                    <GitMerge className="h-4 w-4 mr-2" />
                    Merge with...
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive">
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this people entry?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will delete {people.displayName || 'this entry'} and all their clusters.
                      The underlying embeddings will be kept but unassigned.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </div>

        {/* Voice Clips Section */}
        {people.embeddings.voice.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Volume2 className="h-5 w-5" />
                Voice Clips ({people.embeddings.voice.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <VoiceClipList
                clips={people.embeddings.voice.map((emb) => ({
                  id: emb.id,
                  sourcePath: emb.sourcePath,
                  segmentsWithText: emb.segmentsWithText || [],
                }))}
              />
            </CardContent>
          </Card>
        )}

        {/* Face Crops Section */}
        {people.embeddings.face.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5" />
                Faces ({people.embeddings.face.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
                {people.embeddings.face.map((emb) => (
                  <div key={emb.id} className="relative group">
                    <div className="aspect-square rounded-lg bg-muted flex items-center justify-center">
                      <User className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-0 right-0 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleUnassignEmbedding(emb.id)}
                      title="Remove from this people entry"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                    <p className="text-xs text-muted-foreground truncate mt-1">
                      {emb.sourcePath.split('/').pop()}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty state */}
        {people.embeddings.voice.length === 0 && people.embeddings.face.length === 0 && (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">
                No voice clips or faces linked to this people entry yet.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
