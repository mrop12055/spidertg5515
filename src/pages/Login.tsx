import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Lock, Shield, ShieldCheck, Fingerprint, KeyRound, Zap } from 'lucide-react';
import { toast } from 'sonner';

const Login = () => {
  const [accessCode, setAccessCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const { login } = useAuth();
  const navigate = useNavigate();

  // Track mouse position for interactive glow
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

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

  // Generate falling particles
  const particles = Array.from({ length: 50 }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    delay: Math.random() * 20,
    duration: 10 + Math.random() * 20,
    size: 1 + Math.random() * 3,
    opacity: 0.1 + Math.random() * 0.4,
  }));

  // Generate floating orbs
  const orbs = [
    { top: '10%', left: '15%', size: 300, color: 'primary', delay: 0 },
    { top: '60%', left: '75%', size: 400, color: 'cyan-500', delay: 2 },
    { top: '30%', left: '85%', size: 200, color: 'blue-500', delay: 1 },
    { top: '70%', left: '10%', size: 250, color: 'purple-500', delay: 3 },
    { top: '20%', left: '50%', size: 180, color: 'emerald-500', delay: 1.5 },
  ];

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-background">
      {/* Animated Gradient Background */}
      <div 
        className="absolute inset-0 opacity-50"
        style={{
          background: `radial-gradient(800px circle at ${mousePosition.x}px ${mousePosition.y}px, hsl(var(--primary) / 0.15), transparent 40%)`,
        }}
      />

      {/* Base Gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-background via-background to-primary/5" />

      {/* Animated Grid */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border)/0.2)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/0.2)_1px,transparent_1px)] bg-[size:40px_40px]" />

      {/* Floating Orbs with Gravity Effect */}
      {orbs.map((orb, i) => (
        <div
          key={i}
          className="absolute rounded-full blur-[100px] animate-float"
          style={{
            top: orb.top,
            left: orb.left,
            width: orb.size,
            height: orb.size,
            background: `hsl(var(--${orb.color === 'primary' ? 'primary' : orb.color.replace('-', ' ')}) / 0.15)`,
            animationDelay: `${orb.delay}s`,
            animationDuration: `${8 + i * 2}s`,
          }}
        />
      ))}

      {/* Falling Particles with Gravity */}
      {particles.map((particle) => (
        <div
          key={particle.id}
          className="absolute rounded-full bg-primary animate-fall"
          style={{
            left: `${particle.left}%`,
            width: particle.size,
            height: particle.size,
            opacity: particle.opacity,
            animationDelay: `${particle.delay}s`,
            animationDuration: `${particle.duration}s`,
          }}
        />
      ))}

      {/* Scanning Line Effect */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute w-full h-[2px] bg-gradient-to-r from-transparent via-primary/50 to-transparent animate-scan" />
      </div>

      {/* Hexagon Pattern Overlay */}
      <div className="absolute inset-0 opacity-[0.02]" style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='49' viewBox='0 0 28 49'%3E%3Cg fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M13.99 9.25l13 7.5v15l-13 7.5L1 31.75v-15l12.99-7.5zM3 17.9v12.7l10.99 6.34 11-6.35V17.9l-11-6.34L3 17.9zM0 15l12.98-7.5V0h-2v6.35L0 12.69v2.3zm0 18.5L12.98 41v8h-2v-6.85L0 35.81v-2.3zM15 0v7.5L27.99 15H28v-2.31h-.01L17 6.35V0h-2zm0 49v-8l12.99-7.5H28v2.31h-.01L17 42.15V49h-2z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
      }} />

      {/* Main Card */}
      <div className="relative z-10 w-full max-w-md mx-4 animate-scale-in">
        {/* Outer Glow */}
        <div className="absolute -inset-4 bg-gradient-to-r from-primary/20 via-cyan-500/20 to-blue-500/20 rounded-[2rem] blur-2xl opacity-60 animate-pulse-slow" />
        
        {/* Card Container */}
        <div className="relative group">
          {/* Animated Border */}
          <div className="absolute -inset-[1px] bg-gradient-to-r from-primary via-cyan-500 via-blue-500 to-primary rounded-2xl opacity-75 blur-[2px] group-hover:opacity-100 transition-opacity duration-500 animate-border-spin" />
          
          <div className="relative backdrop-blur-2xl bg-card/90 rounded-2xl shadow-2xl overflow-hidden border border-border/30">
            {/* Top Accent Bar */}
            <div className="h-1 bg-gradient-to-r from-primary via-cyan-500 via-blue-500 to-purple-500 animate-gradient-x" />
            
            {/* Corner Accents */}
            <div className="absolute top-0 left-0 w-20 h-20 border-l-2 border-t-2 border-primary/30 rounded-tl-2xl" />
            <div className="absolute top-0 right-0 w-20 h-20 border-r-2 border-t-2 border-cyan-500/30 rounded-tr-2xl" />
            <div className="absolute bottom-0 left-0 w-20 h-20 border-l-2 border-b-2 border-blue-500/30 rounded-bl-2xl" />
            <div className="absolute bottom-0 right-0 w-20 h-20 border-r-2 border-b-2 border-purple-500/30 rounded-br-2xl" />

            <div className="p-10 sm:p-12">
              {/* Icon Section */}
              <div className="relative flex items-center justify-center mb-10">
                {/* Rotating Ring */}
                <div className="absolute w-36 h-36 border border-primary/20 rounded-full animate-spin-slow" />
                <div className="absolute w-36 h-36 border border-dashed border-cyan-500/20 rounded-full animate-reverse-spin" />
                
                {/* Pulsing Rings */}
                <div className="absolute w-32 h-32 rounded-full border-2 border-primary/30 animate-ping-slow" />
                <div className="absolute w-28 h-28 rounded-full border border-cyan-500/40 animate-ping-slow" style={{ animationDelay: '0.5s' }} />
                <div className="absolute w-24 h-24 rounded-full border border-blue-500/50 animate-ping-slow" style={{ animationDelay: '1s' }} />
                
                {/* Icon Container */}
                <div className="relative w-20 h-20 rounded-2xl overflow-hidden group/icon">
                  {/* Animated Gradient Background */}
                  <div className="absolute inset-0 bg-gradient-to-br from-primary via-cyan-500 to-blue-500 animate-gradient-xy" />
                  <div className="absolute inset-[2px] bg-card rounded-xl flex items-center justify-center">
                    <Shield className="w-10 h-10 text-primary animate-pulse" />
                  </div>
                  {/* Shine Effect */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full animate-shine" />
                </div>
              </div>

              {/* Title Section */}
              <div className="text-center mb-10">
                <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 border border-primary/20 mb-4 animate-fade-in">
                  <Zap className="w-3.5 h-3.5 text-primary animate-pulse" />
                  <span className="text-xs font-medium text-primary tracking-wide">ENTERPRISE SECURITY</span>
                </div>
                
                <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                  <span className="bg-gradient-to-r from-foreground via-primary via-cyan-400 to-foreground bg-[length:200%_auto] bg-clip-text text-transparent animate-gradient-x">
                    Admin Portal
                  </span>
                </h1>
                
                <p className="text-muted-foreground text-sm flex items-center justify-center gap-2">
                  <Fingerprint className="w-4 h-4 animate-pulse" />
                  <span className="tracking-wide">Authorization Required</span>
                </p>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-8">
                {/* Input Container */}
                <div className="relative group/input">
                  {/* Input Glow */}
                  <div className={`absolute -inset-1 bg-gradient-to-r from-primary via-cyan-500 to-blue-500 rounded-xl blur-lg transition-all duration-500 ${isFocused ? 'opacity-50' : 'opacity-0 group-hover/input:opacity-25'}`} />
                  
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 z-10">
                      <div className={`p-2 rounded-lg transition-all duration-300 ${isFocused ? 'bg-primary/20' : 'bg-muted/50'}`}>
                        <KeyRound className={`w-5 h-5 transition-all duration-300 ${isFocused ? 'text-primary scale-110' : 'text-muted-foreground'}`} />
                      </div>
                    </div>
                    <Input
                      type="password"
                      placeholder="Enter authorization code"
                      value={accessCode}
                      onChange={(e) => setAccessCode(e.target.value)}
                      onFocus={() => setIsFocused(true)}
                      onBlur={() => setIsFocused(false)}
                      className="h-16 pl-16 pr-4 text-base bg-background/80 border-2 border-border/50 rounded-xl focus:border-primary/50 focus:ring-4 focus:ring-primary/10 transition-all duration-300 placeholder:text-muted-foreground/50"
                      autoFocus
                    />
                    {/* Typing Indicator */}
                    {accessCode && (
                      <div className="absolute right-4 top-1/2 -translate-y-1/2 flex gap-1">
                        {[0, 1, 2].map((i) => (
                          <div
                            key={i}
                            className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"
                            style={{ animationDelay: `${i * 0.15}s` }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Submit Button */}
                <div className="relative group/btn">
                  <div className="absolute -inset-1 bg-gradient-to-r from-primary via-cyan-500 to-blue-500 rounded-xl blur-lg opacity-50 group-hover/btn:opacity-75 transition-opacity animate-pulse-slow" />
                  
                  <Button 
                    type="submit" 
                    className="relative w-full h-16 text-base font-bold rounded-xl bg-gradient-to-r from-primary via-cyan-500 to-blue-500 hover:from-primary hover:via-cyan-400 hover:to-blue-400 shadow-2xl hover:shadow-primary/30 hover:scale-[1.02] active:scale-[0.98] transition-all duration-300 border-0 overflow-hidden"
                    disabled={isLoading}
                  >
                    {/* Button Shine */}
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent -translate-x-full animate-shine" />
                    
                    {isLoading ? (
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                        <span className="tracking-wide">VERIFYING...</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <Lock className="w-5 h-5" />
                        <span className="tracking-wider">ACCESS SYSTEM</span>
                      </div>
                    )}
                  </Button>
                </div>
              </form>

              {/* Footer */}
              <div className="mt-10 pt-6 border-t border-border/30">
                <div className="flex items-center justify-center gap-3 text-xs">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/20">
                    <ShieldCheck className="w-4 h-4 text-green-500" />
                    <span className="text-green-500 font-medium">Protected</span>
                  </div>
                  
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20">
                    <div className="flex gap-0.5">
                      {[0, 1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className="w-1 h-3 rounded-full bg-primary animate-pulse"
                          style={{ 
                            animationDelay: `${i * 0.1}s`,
                            height: `${8 + (i % 3) * 4}px`
                          }}
                        />
                      ))}
                    </div>
                    <span className="text-primary font-medium">Encrypted</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Branding */}
        <div className="text-center mt-8 space-y-2">
          <p className="text-xs text-muted-foreground/60 tracking-widest">
            ENTERPRISE SECURITY SYSTEM
          </p>
          <p className="text-[10px] text-muted-foreground/40">
            v2.0 • AES-256 Encryption • Multi-Factor Authentication
          </p>
        </div>
      </div>

      {/* Add Custom Animations */}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translateY(0) translateX(0); }
          25% { transform: translateY(-20px) translateX(10px); }
          50% { transform: translateY(-10px) translateX(-10px); }
          75% { transform: translateY(-30px) translateX(5px); }
        }
        
        @keyframes fall {
          0% { transform: translateY(-100vh) rotate(0deg); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
        
        @keyframes scan {
          0% { transform: translateY(-100vh); }
          100% { transform: translateY(100vh); }
        }
        
        @keyframes spin-slow {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        @keyframes reverse-spin {
          0% { transform: rotate(360deg); }
          100% { transform: rotate(0deg); }
        }
        
        @keyframes ping-slow {
          0% { transform: scale(1); opacity: 1; }
          75%, 100% { transform: scale(1.5); opacity: 0; }
        }
        
        @keyframes pulse-slow {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.8; }
        }
        
        @keyframes gradient-x {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        
        @keyframes gradient-xy {
          0% { background-position: 0% 0%; }
          50% { background-position: 100% 100%; }
          100% { background-position: 0% 0%; }
        }
        
        @keyframes shine {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        
        @keyframes border-spin {
          0% { filter: hue-rotate(0deg); }
          100% { filter: hue-rotate(360deg); }
        }
        
        .animate-float { animation: float 8s ease-in-out infinite; }
        .animate-fall { animation: fall linear infinite; }
        .animate-scan { animation: scan 8s linear infinite; }
        .animate-spin-slow { animation: spin-slow 20s linear infinite; }
        .animate-reverse-spin { animation: reverse-spin 15s linear infinite; }
        .animate-ping-slow { animation: ping-slow 3s ease-out infinite; }
        .animate-pulse-slow { animation: pulse-slow 4s ease-in-out infinite; }
        .animate-gradient-x { animation: gradient-x 3s ease infinite; background-size: 200% 200%; }
        .animate-gradient-xy { animation: gradient-xy 5s ease infinite; background-size: 200% 200%; }
        .animate-shine { animation: shine 3s ease-in-out infinite; }
        .animate-border-spin { animation: border-spin 8s linear infinite; }
      `}</style>
    </div>
  );
};

export default Login;
