import { InboxFeed } from "~/components/inbox-feed";

export default function InboxPage() {
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
