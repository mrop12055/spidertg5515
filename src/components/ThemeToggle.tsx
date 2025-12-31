import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/context/ThemeContext';
import { cn } from '@/lib/utils';

interface ThemeToggleProps {
  className?: string;
}

export const ThemeToggle: React.FC<ThemeToggleProps> = ({ className }) => {
  const { theme, toggleTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      className={cn("relative", className)}
    >
      <Sun className={cn(
        "h-5 w-5 transition-all",
        theme === 'dark' ? "rotate-90 scale-0" : "rotate-0 scale-100"
      )} />
      <Moon className={cn(
        "absolute h-5 w-5 transition-all",
        theme === 'dark' ? "rotate-0 scale-100" : "-rotate-90 scale-0"
      )} />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
};
