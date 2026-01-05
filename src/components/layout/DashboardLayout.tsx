import React, { ReactNode, forwardRef } from 'react';
import { Sidebar } from './Sidebar';
import { cn } from '@/lib/utils';

interface DashboardLayoutProps {
  children: ReactNode;
}

export const DashboardLayout = forwardRef<HTMLDivElement, DashboardLayoutProps>(
  ({ children }, ref) => {
    return (
      <div ref={ref} className="min-h-screen bg-background">
        <Sidebar />
        <main className="ml-64 min-h-screen transition-all duration-300">
          <div className="p-6">
            {children}
          </div>
        </main>
      </div>
    );
  }
);

DashboardLayout.displayName = 'DashboardLayout';
