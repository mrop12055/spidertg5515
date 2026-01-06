import React, { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type StableAvatarProps = {
  src?: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  fallback: React.ReactNode;
};

/**
 * Prevents avatar "blinking" by keeping the previous image visible until the new src is fully loaded.
 */
export function StableAvatar({
  src,
  alt,
  className,
  imgClassName,
  fallback,
}: StableAvatarProps) {
  const [displaySrc, setDisplaySrc] = useState<string | undefined>(undefined);
  const lastGoodSrcRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // If src is cleared, clear immediately.
    if (!src) {
      lastGoodSrcRef.current = undefined;
      setDisplaySrc(undefined);
      return;
    }

    // If it's the same as what we already show, do nothing.
    if (src === lastGoodSrcRef.current) return;

    let cancelled = false;
    const img = new Image();

    img.onload = () => {
      if (cancelled) return;
      lastGoodSrcRef.current = src;
      setDisplaySrc(src);
    };

    img.onerror = () => {
      // Keep showing the previous image (no state change) to avoid flicker.
    };

    img.src = src;

    return () => {
      cancelled = true;
    };
  }, [src]);

  const effectiveSrc = displaySrc ?? lastGoodSrcRef.current;

  return (
    <div className={cn("relative overflow-hidden", className)}>
      {/* Fallback always present behind the image to avoid blank frames */}
      <div className="absolute inset-0">{fallback}</div>

      {effectiveSrc ? (
        <img
          src={effectiveSrc}
          alt={alt}
          className={cn("absolute inset-0 h-full w-full object-cover", imgClassName)}
          draggable={false}
        />
      ) : null}
    </div>
  );
}
