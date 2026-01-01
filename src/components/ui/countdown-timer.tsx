import { useState, useEffect, forwardRef } from "react";
import { Clock } from "lucide-react";

interface CountdownTimerProps {
  targetDate: Date;
  className?: string;
  compact?: boolean;
}

function calculateTimeLeft(targetDate: Date) {
  const now = new Date();
  const diff = targetDate.getTime() - now.getTime();

  if (diff <= 0) {
    return { total: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diff % (1000 * 60)) / 1000);

  return { total: diff, hours, minutes, seconds };
}

export const CountdownTimer = forwardRef<HTMLDivElement, CountdownTimerProps>(
  ({ targetDate, className = "", compact = false }, ref) => {
    const [timeLeft, setTimeLeft] = useState(() => calculateTimeLeft(targetDate));

    useEffect(() => {
      const interval = setInterval(() => {
        setTimeLeft(calculateTimeLeft(targetDate));
      }, 1000);

      return () => clearInterval(interval);
    }, [targetDate]);

    if (timeLeft.total <= 0) {
      return <span ref={ref as any} className={className}>Available now</span>;
    }

    if (compact) {
      if (timeLeft.hours > 0) {
        return (
          <span ref={ref as any} className={className}>
            {timeLeft.hours}h {timeLeft.minutes}m
          </span>
        );
      }
      return (
        <span ref={ref as any} className={className}>
          {timeLeft.minutes}m {timeLeft.seconds}s
        </span>
      );
    }

    return (
      <div ref={ref} className={`flex items-center gap-1 ${className}`}>
        <Clock className="w-3 h-3" />
        <span className="font-mono text-xs">
          {timeLeft.hours.toString().padStart(2, '0')}:
          {timeLeft.minutes.toString().padStart(2, '0')}:
          {timeLeft.seconds.toString().padStart(2, '0')}
        </span>
      </div>
    );
  }
);

CountdownTimer.displayName = "CountdownTimer";
