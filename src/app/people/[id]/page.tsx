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
import { ArrowLeft, User, Volume2, Camera, Trash2, GitMerge, MoreHorizontal, X, Check, Pencil } from 'lucide-react';
import type { PersonRecord, PersonCluster, VoiceSourceOffset } from '@/types/models';
import { use } from 'react';
import { VoiceClipList } from '@/components/voice-clip-list';

interface VoiceSegmentWithText {
  start: number;
  end: number;
  text: string;
}

interface PersonEmbeddingDisplay {
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

interface PersonDetail extends PersonRecord {
  clusters: {
    voice: PersonCluster[];
    face: PersonCluster[];
  };
  embeddings: {
    voice: PersonEmbeddingDisplay[];
    face: PersonEmbeddingDisplay[];
  };
}

export default function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const loadPerson = useCallback(async () => {
    try {
      const response = await fetch(`/api/people/${id}`);
      if (response.ok) {
        const data = await response.json();
        setPerson(data);
        setEditName(data.displayName || '');
      } else if (response.status === 404) {
        setPerson(null);
      }
    } catch (error) {
      console.error('Failed to load person:', error);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadPerson();
  }, [loadPerson]);

  const handleSaveName = async () => {
    if (!person || !editName.trim()) return;

    setIsSaving(true);
    try {
      const response = await fetch(`/api/people/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: editName.trim() }),
      });

      if (response.ok) {
        const updated = await response.json();
        setPerson((prev) => (prev ? { ...prev, ...updated } : null));
        setIsEditing(false);
      }
    } catch (error) {
      console.error('Failed to save name:', error);
    } finally {
      setIsSaving(false);
    }
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
      console.error('Failed to delete person:', error);
    }
  };

  const handleUnassignEmbedding = async (embeddingId: string) => {
    try {
      const response = await fetch(`/api/people/embeddings/${embeddingId}/unassign`, {
        method: 'POST',
      });

      if (response.ok) {
        // Reload person data
        loadPerson();
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

  if (!person) {
    return (
      <div className="min-h-screen bg-background">
        <div className="px-[20%] py-8">
          <Card>
            <CardContent className="text-center py-12">
              <User className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-4">Person not found</p>
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
            {person.avatar ? (
              <img
                src={`data:image/jpeg;base64,${person.avatar}`}
                alt={person.displayName || 'Person'}
                className="w-full h-full object-cover"
              />
            ) : person.clusters.face.length > 0 ? (
              <Camera className="h-12 w-12 text-muted-foreground" />
            ) : person.clusters.voice.length > 0 ? (
              <Volume2 className="h-12 w-12 text-muted-foreground" />
            ) : (
              <User className="h-12 w-12 text-muted-foreground" />
            )}
          </div>

          {/* Name and actions */}
          <div className="flex-1">
            {isEditing ? (
              <div className="flex items-center gap-2">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Enter name"
                  className="text-2xl font-bold h-12"
                  autoFocus
                />
                <Button onClick={handleSaveName} disabled={isSaving || !editName.trim()}>
                  <Check className="h-4 w-4" />
                </Button>
                <Button variant="ghost" onClick={() => setIsEditing(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h1 className={`text-3xl font-bold ${person.isPending ? 'text-muted-foreground italic' : 'text-foreground'}`}>
                  {person.displayName || 'Add a name'}
                </h1>
                <Button variant="ghost" size="icon" onClick={() => setIsEditing(true)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </div>
            )}

            <p className="text-muted-foreground mt-2">
              {person.clusters.voice.length} voice cluster{person.clusters.voice.length !== 1 ? 's' : ''}
              {person.clusters.face.length > 0 && (
                <> &middot; {person.clusters.face.length} face cluster{person.clusters.face.length !== 1 ? 's' : ''}</>
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
                    <AlertDialogTitle>Delete person?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will delete {person.displayName || 'this person'} and all their clusters.
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
        {person.embeddings.voice.length > 0 && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Volume2 className="h-5 w-5" />
                Voice Clips ({person.embeddings.voice.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <VoiceClipList
                clips={person.embeddings.voice.map((emb) => ({
                  id: emb.id,
                  sourcePath: emb.sourcePath,
                  segmentsWithText: emb.segmentsWithText || [],
                }))}
              />
            </CardContent>
          </Card>
        )}

        {/* Face Crops Section */}
        {person.embeddings.face.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5" />
                Faces ({person.embeddings.face.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
                {person.embeddings.face.map((emb) => (
                  <div key={emb.id} className="relative group">
                    <div className="aspect-square rounded-lg bg-muted flex items-center justify-center">
                      <User className="h-8 w-8 text-muted-foreground" />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute top-0 right-0 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleUnassignEmbedding(emb.id)}
                      title="Remove from this person"
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
        {person.embeddings.voice.length === 0 && person.embeddings.face.length === 0 && (
          <Card>
            <CardContent className="text-center py-12">
              <p className="text-muted-foreground">
                No voice clips or faces linked to this person yet.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
