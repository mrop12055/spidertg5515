 import React from 'react';
 import { AlertTriangle, Clock } from 'lucide-react';
 import { cn } from '@/lib/utils';
 import { AccountStatus } from '@/types/telegram';
 
 interface AccountStatusWarningProps {
   status: AccountStatus;
   restrictedUntil?: Date | null;
   className?: string;
 }
 
 /**
  * Displays a warning banner when the sender account is in restricted or cooldown status.
  * Allows users to still attempt sending (messages may succeed during brief windows).
  */
 export const AccountStatusWarning: React.FC<AccountStatusWarningProps> = ({
   status,
   restrictedUntil,
   className
 }) => {
   // Only show for restricted or cooldown statuses
   if (status !== 'restricted' && status !== 'cooldown') {
     return null;
   }
 
   const isRestricted = status === 'restricted';
   const Icon = isRestricted ? AlertTriangle : Clock;
   
   // Calculate remaining time if restrictedUntil is available
   let timeRemaining = '';
   if (restrictedUntil) {
     const now = new Date();
     const remaining = restrictedUntil.getTime() - now.getTime();
     if (remaining > 0) {
       const hours = Math.floor(remaining / (1000 * 60 * 60));
       const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
       if (hours > 0) {
         timeRemaining = ` (~${hours}h ${minutes}m remaining)`;
       } else if (minutes > 0) {
         timeRemaining = ` (~${minutes}m remaining)`;
       }
     }
   }
 
   return (
     <div 
       className={cn(
         "flex items-center gap-2 px-3 py-2 text-sm rounded-lg border",
         isRestricted 
           ? "bg-status-restricted/10 text-status-restricted border-status-restricted/30"
           : "bg-status-cooldown/10 text-status-cooldown border-status-cooldown/30",
         className
       )}
     >
       <Icon className="w-4 h-4 flex-shrink-0" />
       <span className="flex-1">
         {isRestricted 
           ? `Sender account is temporarily restricted.${timeRemaining} Messages may fail.`
           : `Sender account is on cooldown.${timeRemaining} Messages may fail.`
         }
       </span>
     </div>
   );
 };