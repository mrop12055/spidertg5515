import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Lock, Shield, ShieldCheck, Fingerprint, KeyRound } from 'lucide-react';
import { toast } from 'sonner';

const Login = () => {
  const [accessCode, setAccessCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!accessCode.trim()) {
      toast.error('Please enter your access code');
      return;
    }

    setIsLoading(true);
    
    const success = await login(accessCode.trim());
    
    if (success) {
      toast.success('Access granted');
      navigate('/dashboard');
    } else {
      toast.error('Invalid access code');
    }
    
    setIsLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-gradient-to-br from-background via-background to-primary/5">
      {/* Animated Background Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.3)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.3)_1px,transparent_1px)] bg-[size:60px_60px]" />
      
      {/* Radial Gradient Overlay */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,hsl(var(--primary)/0.15)_0%,transparent_70%)]" />
      
      {/* Floating Orbs */}
      <div className="absolute top-1/4 left-1/4 w-64 h-64 bg-primary/20 rounded-full blur-[100px] animate-pulse" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-cyan-500/15 rounded-full blur-[120px] animate-pulse" style={{ animationDelay: '1s' }} />
      <div className="absolute top-1/3 right-1/3 w-48 h-48 bg-blue-500/10 rounded-full blur-[80px] animate-pulse" style={{ animationDelay: '2s' }} />
      <div className="absolute bottom-1/3 left-1/3 w-56 h-56 bg-purple-500/10 rounded-full blur-[90px] animate-pulse" style={{ animationDelay: '0.5s' }} />
      
      {/* Floating Particles */}
      <div className="absolute top-20 left-20 w-2 h-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDuration: '3s' }} />
      <div className="absolute top-40 right-32 w-1.5 h-1.5 bg-cyan-400/60 rounded-full animate-bounce" style={{ animationDuration: '4s', animationDelay: '1s' }} />
      <div className="absolute bottom-32 left-40 w-2 h-2 bg-blue-400/50 rounded-full animate-bounce" style={{ animationDuration: '3.5s', animationDelay: '0.5s' }} />
      <div className="absolute bottom-20 right-20 w-1.5 h-1.5 bg-purple-400/50 rounded-full animate-bounce" style={{ animationDuration: '4.5s', animationDelay: '1.5s' }} />

      {/* Main Card */}
      <div className="relative z-10 w-full max-w-md mx-4">
        {/* Card Glow Effect */}
        <div className="absolute -inset-1 bg-gradient-to-r from-primary/50 via-cyan-500/50 to-blue-500/50 rounded-3xl blur-xl opacity-30 group-hover:opacity-50 transition-opacity" />
        
        <div className="relative backdrop-blur-xl bg-card/80 border border-border/50 rounded-2xl shadow-2xl overflow-hidden">
          {/* Top Gradient Bar */}
          <div className="h-1 bg-gradient-to-r from-primary via-cyan-500 to-blue-500" />
          
          <div className="p-8 sm:p-10">
            {/* Icon Section with Animated Rings */}
            <div className="relative flex items-center justify-center mb-8">
              {/* Outer Ring */}
              <div className="absolute w-32 h-32 rounded-full border border-primary/20 animate-ping" style={{ animationDuration: '3s' }} />
              {/* Middle Ring */}
              <div className="absolute w-28 h-28 rounded-full border border-cyan-500/30 animate-ping" style={{ animationDuration: '2.5s', animationDelay: '0.5s' }} />
              {/* Inner Ring */}
              <div className="absolute w-24 h-24 rounded-full border border-blue-500/40 animate-ping" style={{ animationDuration: '2s', animationDelay: '1s' }} />
              
              {/* Icon Container */}
              <div className="relative w-20 h-20 bg-gradient-to-br from-primary/20 via-cyan-500/20 to-blue-500/20 rounded-2xl flex items-center justify-center border border-border/50 shadow-lg">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent rounded-2xl" />
                <Shield className="w-10 h-10 text-primary relative z-10" />
              </div>
            </div>

            {/* Title Section */}
            <div className="text-center mb-8">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2 bg-gradient-to-r from-foreground via-primary to-cyan-400 bg-clip-text text-transparent">
                SECURE ADMIN PORTAL
              </h1>
              <p className="text-muted-foreground text-sm flex items-center justify-center gap-2">
                <Fingerprint className="w-4 h-4" />
                Authorization Required
              </p>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Input Container */}
              <div className="relative group">
                {/* Input Glow */}
                <div className={`absolute -inset-0.5 bg-gradient-to-r from-primary via-cyan-500 to-blue-500 rounded-xl blur opacity-0 transition-opacity duration-300 ${isFocused ? 'opacity-50' : 'group-hover:opacity-25'}`} />
                
                <div className="relative">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 z-10">
                    <KeyRound className={`w-5 h-5 transition-colors duration-300 ${isFocused ? 'text-primary' : 'text-muted-foreground'}`} />
                  </div>
                  <Input
                    type="password"
                    placeholder="Enter authorization code"
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    className="h-14 pl-12 pr-4 text-base bg-background/50 border-border/50 rounded-xl focus:border-primary/50 focus:ring-2 focus:ring-primary/20 transition-all duration-300"
                    autoFocus
                  />
                </div>
              </div>

              {/* Submit Button */}
              <Button 
                type="submit" 
                className="w-full h-14 text-base font-semibold rounded-xl bg-gradient-to-r from-primary via-cyan-500 to-blue-500 hover:from-primary/90 hover:via-cyan-500/90 hover:to-blue-500/90 shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:scale-[1.02] transition-all duration-300 border-0"
                disabled={isLoading}
              >
                {isLoading ? (
                  <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Verifying...</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Lock className="w-5 h-5" />
                    <span>ACCESS SYSTEM</span>
                  </div>
                )}
              </Button>
            </form>

            {/* Footer */}
            <div className="mt-8 pt-6 border-t border-border/50">
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="w-4 h-4 text-green-500" />
                <span>Protected Access</span>
                <div className="flex gap-1 ml-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500/60 animate-pulse" style={{ animationDelay: '0.2s' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-green-500/30 animate-pulse" style={{ animationDelay: '0.4s' }} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Branding */}
        <p className="text-center text-xs text-muted-foreground/50 mt-6">
          Enterprise Security System v2.0
        </p>
      </div>
    </div>
  );
};

export default Login;
