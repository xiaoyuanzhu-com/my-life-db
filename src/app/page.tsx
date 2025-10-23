'use client';

import { QuickAdd } from '@/components/QuickAdd';

export default function HomePage() {
  return (
    <div className="flex-1 flex flex-col justify-start px-4">
      <div className="flex-[0.4]" />
      <div className="w-full max-w-3xl mx-auto">
        <QuickAdd />
      </div>
      <div className="flex-[0.6]" />
    </div>
  );
}
