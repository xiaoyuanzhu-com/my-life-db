import { InboxFeed } from "~/components/inbox-feed";
import { useAuth } from "~/contexts/auth-context";

export default function InboxPage() {
  const { isAuthenticated, isLoading } = useAuth();

  // Show loading state while checking authentication
  if (isLoading) {
    return null;
  }

  // Show welcome page when not authenticated
  if (!isAuthenticated) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <div>
          <h1 className="text-3xl font-bold mb-4">Inbox</h1>
          <p className="text-muted-foreground text-lg mb-8 max-w-2xl">
            View and manage your unprocessed items waiting to be organized.
          </p>
          <p className="text-muted-foreground">
            Please sign in using the button in the header to get started.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      <div className="px-[20%] py-4 flex-none">
        <h1 className="text-3xl font-bold text-foreground">Inbox</h1>
      </div>
      <div className="flex-1 overflow-hidden">
        <InboxFeed />
      </div>
    </div>
  );
}
