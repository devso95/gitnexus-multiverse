import { useEffect, useState } from 'react';

interface LoadingProgressProps {
  isLoading: boolean;
  label?: string;
  showPercentage?: boolean;
  showETA?: boolean;
  estimatedDuration?: number; // in milliseconds
}

export function LoadingProgress({
  isLoading,
  label = 'Loading...',
  showPercentage = true,
  showETA = true,
  estimatedDuration = 5000,
}: LoadingProgressProps) {
  const [progress, setProgress] = useState(0);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [startTime, setStartTime] = useState<number | null>(null);

  useEffect(() => {
    if (!isLoading) {
      setProgress(0);
      setElapsedTime(0);
      setStartTime(null);
      return;
    }

    // Initialize start time on first load
    if (startTime === null) {
      setStartTime(Date.now());
    }

    const interval = setInterval(() => {
      setElapsedTime((prev) => prev + 100);

      // Simulate progress with ease-out curve (progress slows down as it approaches 100)
      setProgress((prev) => {
        if (prev >= 95) return 95; // Cap at 95% until actual completion
        const increase = (100 - prev) * 0.08; // Diminishing returns
        return Math.min(prev + increase, 95);
      });
    }, 100);

    return () => clearInterval(interval);
  }, [isLoading, startTime]);

  // Jump to 100% when loading completes
  useEffect(() => {
    if (!isLoading && progress > 0) {
      setProgress(100);
      const timeout = setTimeout(() => {
        setProgress(0);
        setElapsedTime(0);
        setStartTime(null);
      }, 600);
      return () => clearTimeout(timeout);
    }
  }, [isLoading, progress]);

  if (!isLoading && progress === 0) {
    return null;
  }

  const displayProgress = Math.round(progress);
  const eta =
    estimatedDuration - elapsedTime > 0 ? Math.ceil((estimatedDuration - elapsedTime) / 1000) : 0;

  return (
    <div className="border-border flex flex-col gap-2 border-b bg-surface/50 px-5 py-3">
      {/* Label with percentage */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-text font-medium">{label}</span>
        <div className="text-text2 flex gap-3 text-xs">
          {showPercentage && <span>{displayProgress}%</span>}
          {showETA && eta > 0 && <span>~{eta}s remaining</span>}
        </div>
      </div>

      {/* Progress bar with animated gradient */}
      <div className="bg-surface2 h-2 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent via-accent to-accent/60 transition-all duration-300 ease-out"
          style={{
            width: `${displayProgress}%`,
            boxShadow: displayProgress > 0 ? '0 0 10px rgba(var(--accent-rgb), 0.5)' : 'none',
          }}
        />
      </div>

      {/* Animated dots indicator */}
      <div className="flex justify-center gap-1 py-1">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
            style={{
              animationDelay: `${i * 150}ms`,
              opacity: 0.6 + Math.sin((Date.now() + i * 150) / 300) * 0.4,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Simplified spinner component (for quick operations)
 */
export function LoadingSpinner({
  label = 'Loading...',
  size = 'md',
}: {
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizeMap = {
    sm: 'h-6 w-6',
    md: 'h-8 w-8',
    lg: 'h-12 w-12',
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className={`${sizeMap[size]} animate-spin rounded-full border-2 border-accent/30 border-t-accent`}
      />
      {label && <span className="text-text2 text-sm">{label}</span>}
    </div>
  );
}

/**
 * Hook to manage loading progress state
 * Usage:
 *   const { start, progress, stop } = useLoadingProgress();
 *   start('Loading data...');
 *   // ... do async work
 *   stop();
 */
export function useLoadingProgress() {
  const [isLoading, setIsLoading] = useState(false);
  const [label, setLabel] = useState('Loading...');

  return {
    isLoading,
    label,
    start: (msg: string = 'Loading...') => {
      setLabel(msg);
      setIsLoading(true);
    },
    stop: () => {
      setIsLoading(false);
    },
  };
}
