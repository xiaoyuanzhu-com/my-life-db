import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router";
import { Card, CardContent } from "~/components/ui/card";
import { User, Volume2, Camera } from "lucide-react";
import { useAuth } from "~/contexts/auth-context";
import type { PeopleWithCounts } from "~/types/models";
import { api } from "~/lib/api";

interface PeopleResponse {
  people: PeopleWithCounts[];
  total: number;
}

export default function PeoplePage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [people, setPeople] = useState<PeopleWithCounts[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadPeople() {
      try {
        const response = await api.get("/api/people");
        const data: PeopleResponse = await response.json();
        setPeople(data.people);
      } catch (error) {
        console.error("Failed to load people:", error);
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

  // Show loading state while checking authentication
  if (authLoading) {
    return null;
  }

  // Show welcome page when not authenticated
  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">People</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            Manage and discover people automatically identified from your audio files.
          </p>
          <p className="text-muted-foreground">
            Please sign in using the button in the header to get started.
          </p>
        </div>
      </div>
    );
  }

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
                <h2 className="text-xl font-semibold text-foreground">Identified ({identified.length})</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  {identified.map((entry) => (
                    <PeopleCard key={entry.id} people={entry} />
                  ))}
                </div>
              </section>
            )}

            {/* Pending People Section */}
            {pending.length > 0 && (
              <section className="space-y-4">
                <h2 className="text-xl font-semibold text-foreground">Pending ({pending.length})</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  {pending.map((entry) => (
                    <PeopleCard key={entry.id} people={entry} />
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

function PeopleCard({ people }: { people: PeopleWithCounts }) {
  const hasVoice = people.voiceClusterCount > 0;
  const hasFace = people.faceClusterCount > 0;

  return (
    <Link to={`/people/${people.id}`}>
      <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
        <CardContent className="p-4 flex flex-col items-center text-center">
          {/* Avatar */}
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-3 overflow-hidden">
            {people.avatar ? (
              <img
                src={`data:image/jpeg;base64,${people.avatar}`}
                alt={people.displayName || "People"}
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
          <p
            className={`text-sm font-medium truncate w-full ${
              people.isPending ? "text-muted-foreground italic" : "text-foreground"
            }`}
          >
            {people.displayName || "Add a name"}
          </p>

          {/* Stats */}
          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
            {hasVoice && (
              <span className="flex items-center gap-1">
                <Volume2 className="h-3 w-3" />
                {people.voiceClusterCount}
              </span>
            )}
            {hasFace && (
              <span className="flex items-center gap-1">
                <Camera className="h-3 w-3" />
                {people.faceClusterCount}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
