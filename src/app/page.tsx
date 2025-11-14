'use client';

import { OmniInput } from '@/components/OmniInput';

export default function HomePage() {
  return (
    <div className="flex-1 relative">
      <div className="fixed top-[30vh] left-1/2 -translate-x-1/2 w-full max-w-3xl px-4">
        <OmniInput />
      </div>
    </div>
  );
}
