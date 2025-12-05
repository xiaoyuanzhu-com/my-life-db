'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { User, Volume2, Camera, Plus } from 'lucide-react';
import type { PersonWithCounts } from '@/types/models';

interface PeopleResponse {
  people: PersonWithCounts[];
  total: number;
}

export default function PeoplePage() {
  const [people, setPeople] = useState<PersonWithCounts[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadPeople() {
      try {
        const response = await fetch('/api/people');
        const data: PeopleResponse = await response.json();
        setPeople(data.people);
      } catch (error) {
        console.error('Failed to load people:', error);
      } finally {
        setIsLoading(false);
      }
    }

    loadPeople();
  }, []);

  // Separate identified and pending people
  const { identified, pending } = useMemo(() => {
    return {
      identified: people.filter((p) => !p.isPending),
      pending: people.filter((p) => p.isPending),
    };
  }, [people]);

  return (
    <div className="min-h-screen bg-background">
      <div className="px-[20%] py-8">
        {/* Page Header */}
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-foreground">People</h1>
        </div>

        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading...</div>
        ) : people.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12">
              <User className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-2">No people discovered yet.</p>
              <p className="text-sm text-muted-foreground">
                Upload audio files with speech to automatically detect speakers.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            {/* Identified People Section */}
            {identified.length > 0 && (
              <section className="space-y-4">
                <h2 className="text-xl font-semibold text-foreground">
                  Identified ({identified.length})
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  {identified.map((person) => (
                    <PersonCard key={person.id} person={person} />
                  ))}
                </div>
              </section>
            )}

            {/* Pending People Section */}
            {pending.length > 0 && (
              <section className="space-y-4">
                <h2 className="text-xl font-semibold text-foreground">
                  Pending ({pending.length})
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  {pending.map((person) => (
                    <PersonCard key={person.id} person={person} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PersonCard({ person }: { person: PersonWithCounts }) {
  const hasVoice = person.voiceClusterCount > 0;
  const hasFace = person.faceClusterCount > 0;

  return (
    <Link href={`/people/${person.id}`}>
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
        <CardContent className="p-4 flex flex-col items-center text-center">
          {/* Avatar */}
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-3 overflow-hidden">
            {person.avatar ? (
              <img
                src={`data:image/jpeg;base64,${person.avatar}`}
                alt={person.displayName || 'Person'}
                className="w-full h-full object-cover"
              />
            ) : hasFace ? (
              <Camera className="h-8 w-8 text-muted-foreground" />
            ) : hasVoice ? (
              <Volume2 className="h-8 w-8 text-muted-foreground" />
            ) : (
              <User className="h-8 w-8 text-muted-foreground" />
            )}
          </div>

          {/* Name */}
          <p className={`text-sm font-medium truncate w-full ${
            person.isPending ? 'text-muted-foreground italic' : 'text-foreground'
          }`}>
            {person.displayName || 'Add a name'}
          </p>

          {/* Stats */}
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            {hasVoice && (
              <span className="flex items-center gap-1">
                <Volume2 className="h-3 w-3" />
                {person.voiceClusterCount}
              </span>
            )}
            {hasFace && (
              <span className="flex items-center gap-1">
                <Camera className="h-3 w-3" />
                {person.faceClusterCount}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
