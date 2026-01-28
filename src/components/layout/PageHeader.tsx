import React, { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { motion } from "framer-motion";

interface PageHeaderProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

// Use stable variants (avoid re-animating on frequent rerenders)
const headerVariants = {
  hidden: { opacity: 0, y: -10 },
  show: { opacity: 1, y: 0 },
} as const;

const iconVariants = {
  hidden: { opacity: 0, scale: 0.5, rotate: -10 },
  show: { opacity: 1, scale: 1, rotate: 0 },
} as const;

const titleVariants = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0 },
} as const;

const descVariants = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0 },
} as const;

const actionsVariants = {
  hidden: { opacity: 0, x: 10 },
  show: { opacity: 1, x: 0 },
} as const;

const headerTransition = {
  duration: 0.4,
  ease: [0.25, 0.46, 0.45, 0.94],
} as const;

const iconTransition = {
  duration: 0.5,
  delay: 0.1,
  type: "spring",
  stiffness: 200,
} as const;

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
}) => {
  // Only animate on initial mount - not on every re-render
  const [hasAnimated, setHasAnimated] = useState(false);
  
  useEffect(() => {
    // Mark as animated after mount
    setHasAnimated(true);
  }, []);

  // After first render, skip animations to prevent "refreshing" appearance
  const shouldAnimate = !hasAnimated;

  return (
    <motion.div
      initial={shouldAnimate ? "hidden" : false}
      animate="show"
      variants={headerVariants}
      transition={headerTransition}
      className={cn(
        "flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8",
        className
      )}
    >
      <div className="flex items-center gap-4">
        {Icon && (
          <motion.div
            initial={shouldAnimate ? "hidden" : false}
            animate="show"
            variants={iconVariants}
            transition={iconTransition}
            className="w-14 h-14 rounded-2xl gradient-primary flex items-center justify-center shadow-lg shadow-primary/20"
          >
            <Icon className="w-7 h-7 text-primary-foreground" strokeWidth={1.5} />
          </motion.div>
        )}

        <div>
          <motion.h1
            initial={shouldAnimate ? "hidden" : false}
            animate="show"
            variants={titleVariants}
            transition={{ duration: 0.4, delay: 0.15 }}
            className="text-2xl font-bold text-foreground tracking-tight"
          >
            {title}
          </motion.h1>

          {description && (
            <motion.p
              initial={shouldAnimate ? "hidden" : false}
              animate="show"
              variants={descVariants}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="text-muted-foreground text-sm mt-0.5"
            >
              {description}
            </motion.p>
          )}
        </div>
      </div>

      {(action || children) && (
        <div className="flex items-center gap-3">
          {action}
          {children}
        </div>
      )}
    </motion.div>
  );
};
