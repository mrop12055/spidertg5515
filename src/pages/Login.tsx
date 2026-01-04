import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Lock, Shield, ShieldCheck, Fingerprint, KeyRound, Zap, Cpu, Radio, Wifi, Server } from 'lucide-react';
import { toast } from 'sonner';

const Login = () => {
  const [accessCode, setAccessCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [time, setTime] = useState(new Date());
  const [typedChars, setTypedChars] = useState<string[]>([]);
  const { login } = useAuth();
  const navigate = useNavigate();

  // Update time every second
  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Track mouse position
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // Matrix rain characters
  const matrixChars = '01アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
  
  // Generate matrix columns
  const matrixColumns = Array.from({ length: 40 }, (_, i) => ({
    id: i,
    left: (i / 40) * 100,
    delay: Math.random() * 10,
    duration: 5 + Math.random() * 10,
    chars: Array.from({ length: 20 }, () => matrixChars[Math.floor(Math.random() * matrixChars.length)]),
  }));

  // Hexagon grid points
  const hexPoints = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: Math.random() * 100,
    delay: Math.random() * 5,
  }));

  // Floating tech icons
  const techIcons = [
    { Icon: Cpu, top: '15%', left: '10%', delay: 0 },
    { Icon: Radio, top: '25%', left: '85%', delay: 1 },
    { Icon: Wifi, top: '70%', left: '8%', delay: 2 },
    { Icon: Server, top: '75%', left: '88%', delay: 0.5 },
  ];

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

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    if (newValue.length > accessCode.length) {
      setTypedChars(prev => [...prev.slice(-10), newValue[newValue.length - 1]]);
    }
    setAccessCode(newValue);
  }, [accessCode]);

  return (
    <div className="min-h-screen flex items-center justify-center relative overflow-hidden bg-background perspective-1000">
      {/* Dynamic Mouse Gradient */}
      <div 
        className="absolute inset-0 opacity-40 transition-all duration-300"
        style={{
          background: `
            radial-gradient(600px circle at ${mousePosition.x}px ${mousePosition.y}px, hsl(var(--primary) / 0.2), transparent 40%),
            radial-gradient(400px circle at ${mousePosition.x + 100}px ${mousePosition.y - 100}px, hsl(195 100% 50% / 0.1), transparent 40%)
          `,
        }}
      />

      {/* Matrix Rain Effect */}
      <div className="absolute inset-0 overflow-hidden opacity-[0.07]">
        {matrixColumns.map((col) => (
          <div
            key={col.id}
            className="absolute top-0 text-primary font-mono text-xs animate-matrix-fall whitespace-nowrap"
            style={{
              left: `${col.left}%`,
              animationDelay: `${col.delay}s`,
              animationDuration: `${col.duration}s`,
            }}
          >
            {col.chars.map((char, i) => (
              <div key={i} style={{ opacity: 1 - (i * 0.05) }}>{char}</div>
            ))}
          </div>
        ))}
      </div>

      {/* Animated Grid with Perspective */}
      <div 
        className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--primary)/0.1)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--primary)/0.1)_1px,transparent_1px)] bg-[size:50px_50px]"
        style={{
          transform: 'perspective(500px) rotateX(60deg)',
          transformOrigin: 'center 120%',
          maskImage: 'linear-gradient(to top, black 30%, transparent 70%)',
        }}
      />

      {/* Floating Connection Lines */}
      <svg className="absolute inset-0 w-full h-full opacity-20">
        {hexPoints.map((point, i) => (
          hexPoints.slice(i + 1, i + 3).map((nextPoint, j) => (
            <line
              key={`${i}-${j}`}
              x1={`${point.x}%`}
              y1={`${point.y}%`}
              x2={`${nextPoint.x}%`}
              y2={`${nextPoint.y}%`}
              stroke="hsl(var(--primary))"
              strokeWidth="0.5"
              className="animate-pulse-slow"
              style={{ animationDelay: `${point.delay}s` }}
            />
          ))
        ))}
        {hexPoints.map((point) => (
          <circle
            key={point.id}
            cx={`${point.x}%`}
            cy={`${point.y}%`}
            r="2"
            fill="hsl(var(--primary))"
            className="animate-pulse"
            style={{ animationDelay: `${point.delay}s` }}
          />
        ))}
      </svg>

      {/* Floating Tech Icons */}
      {techIcons.map(({ Icon, top, left, delay }, i) => (
        <div
          key={i}
          className="absolute opacity-20 animate-float-rotate"
          style={{ top, left, animationDelay: `${delay}s` }}
        >
          <Icon className="w-8 h-8 text-primary" />
        </div>
      ))}

      {/* Scanning Lines */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent animate-scan-vertical" />
        <div className="absolute w-[1px] h-full bg-gradient-to-b from-transparent via-cyan-500 to-transparent animate-scan-horizontal" />
      </div>

      {/* Circular Radar Effect */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] opacity-10">
        <div className="absolute inset-0 rounded-full border border-primary/30" />
        <div className="absolute inset-[15%] rounded-full border border-primary/20" />
        <div className="absolute inset-[30%] rounded-full border border-primary/10" />
        <div className="absolute inset-0 rounded-full overflow-hidden">
          <div className="absolute top-1/2 left-1/2 w-1/2 h-[2px] bg-gradient-to-r from-primary to-transparent origin-left animate-radar" />
        </div>
      </div>

      {/* Main Card */}
      <div className="relative z-10 w-full max-w-lg mx-4 animate-scale-in">
        {/* Holographic Effect */}
        <div className="absolute -inset-8 bg-gradient-conic from-primary via-cyan-500 via-blue-500 via-purple-500 to-primary rounded-3xl blur-3xl opacity-20 animate-spin-very-slow" />
        
        {/* Card Container */}
        <div className="relative group">
          {/* Animated Border Gradient */}
          <div className="absolute -inset-[2px] bg-gradient-to-r from-primary via-cyan-500 via-blue-500 via-purple-500 to-primary rounded-2xl opacity-80 animate-border-flow" />
          
          <div className="relative backdrop-blur-2xl bg-card/95 rounded-2xl shadow-2xl overflow-hidden">
            {/* Top Bar with Status */}
            <div className="relative h-12 bg-gradient-to-r from-primary/10 via-cyan-500/10 to-blue-500/10 border-b border-border/30 flex items-center justify-between px-4">
              {/* Window Controls */}
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-500 transition-colors cursor-pointer" />
                <div className="w-3 h-3 rounded-full bg-yellow-500/80 hover:bg-yellow-500 transition-colors cursor-pointer" />
                <div className="w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-500 transition-colors cursor-pointer" />
              </div>
              
              {/* Terminal Title */}
              <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-2 text-xs text-muted-foreground font-mono">
                <Shield className="w-3.5 h-3.5 text-primary" />
                <span>secure_portal.exe</span>
              </div>
              
              {/* Live Time */}
              <div className="text-xs font-mono text-primary tabular-nums">
                {time.toLocaleTimeString()}
              </div>
            </div>

            <div className="p-10 sm:p-12">
              {/* Biometric Scanner Animation */}
              <div className="relative flex items-center justify-center mb-10">
                {/* DNA Helix Rings */}
                <div className="absolute w-44 h-44">
                  {[...Array(3)].map((_, i) => (
                    <div
                      key={i}
                      className="absolute inset-0 rounded-full border-2 border-dashed animate-spin-slow"
                      style={{
                        borderColor: `hsl(var(--primary) / ${0.3 - i * 0.1})`,
                        animationDuration: `${20 + i * 5}s`,
                        animationDirection: i % 2 === 0 ? 'normal' : 'reverse',
                      }}
                    />
                  ))}
                </div>

                {/* Orbiting Dots */}
                {[...Array(8)].map((_, i) => (
                  <div
                    key={i}
                    className="absolute w-40 h-40 animate-spin-slow"
                    style={{
                      animationDuration: `${8 + i}s`,
                      animationDirection: i % 2 === 0 ? 'normal' : 'reverse',
                    }}
                  >
                    <div
                      className="absolute w-2 h-2 rounded-full bg-primary"
                      style={{
                        top: '0%',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        boxShadow: '0 0 10px hsl(var(--primary))',
                      }}
                    />
                  </div>
                ))}

                {/* Center Scanner */}
                <div className="relative w-24 h-24">
                  {/* Scanner Ring */}
                  <div className="absolute inset-0 rounded-full border-4 border-primary/30 overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-b from-primary/20 to-transparent animate-scan-biometric" />
                  </div>
                  
                  {/* Inner Glow */}
                  <div className="absolute inset-2 rounded-full bg-gradient-to-br from-primary/20 via-transparent to-cyan-500/20 flex items-center justify-center">
                    <Fingerprint className="w-12 h-12 text-primary animate-pulse" />
                  </div>
                  
                  {/* Corner Brackets */}
                  <div className="absolute -top-2 -left-2 w-6 h-6 border-t-2 border-l-2 border-primary rounded-tl-lg" />
                  <div className="absolute -top-2 -right-2 w-6 h-6 border-t-2 border-r-2 border-primary rounded-tr-lg" />
                  <div className="absolute -bottom-2 -left-2 w-6 h-6 border-b-2 border-l-2 border-primary rounded-bl-lg" />
                  <div className="absolute -bottom-2 -right-2 w-6 h-6 border-b-2 border-r-2 border-primary rounded-br-lg" />
                </div>
              </div>

              {/* Title Section */}
              <div className="text-center mb-10">
                {/* Glitch Text Effect */}
                <div className="relative inline-block mb-4">
                  <h1 className="text-3xl sm:text-4xl font-black tracking-tighter text-foreground glitch-text" data-text="ADMIN PORTAL">
                    ADMIN PORTAL
                  </h1>
                </div>
                
                {/* Animated Subtitle */}
                <div className="flex items-center justify-center gap-3 text-sm">
                  <div className="h-[1px] w-12 bg-gradient-to-r from-transparent to-primary" />
                  <span className="text-muted-foreground font-mono tracking-widest text-xs">
                    LEVEL 5 CLEARANCE REQUIRED
                  </span>
                  <div className="h-[1px] w-12 bg-gradient-to-l from-transparent to-primary" />
                </div>
              </div>

              {/* Floating Typed Characters */}
              <div className="absolute top-20 right-10 pointer-events-none">
                {typedChars.map((char, i) => (
                  <span
                    key={i}
                    className="absolute text-primary/40 font-mono text-lg animate-float-up"
                    style={{
                      right: `${Math.random() * 40}px`,
                      animationDelay: `${i * 0.1}s`,
                    }}
                  >
                    {char === ' ' ? '•' : '*'}
                  </span>
                ))}
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-8">
                {/* Input Container */}
                <div className="relative group/input">
                  {/* Holographic Input Glow */}
                  <div className={`absolute -inset-2 bg-gradient-conic from-primary via-cyan-500 via-blue-500 to-primary rounded-2xl blur-xl transition-all duration-500 ${isFocused ? 'opacity-40' : 'opacity-0 group-hover/input:opacity-20'}`} />
                  
                  <div className="relative bg-background/50 rounded-xl border-2 border-border/50 p-1 transition-all duration-300 group-hover/input:border-primary/30">
                    <div className="flex items-center gap-3 px-4">
                      {/* Animated Icon */}
                      <div className={`relative p-2 rounded-lg transition-all duration-300 ${isFocused ? 'bg-primary text-primary-foreground scale-110' : 'bg-muted'}`}>
                        <KeyRound className="w-5 h-5" />
                        {isFocused && (
                          <div className="absolute inset-0 rounded-lg bg-primary animate-ping opacity-50" />
                        )}
                      </div>
                      
                      <div className="flex-1 relative">
                        <Input
                          type="password"
                          placeholder="ENTER AUTHORIZATION CODE"
                          value={accessCode}
                          onChange={handleInputChange}
                          onFocus={() => setIsFocused(true)}
                          onBlur={() => setIsFocused(false)}
                          className="h-14 px-0 text-base font-mono tracking-widest bg-transparent border-0 focus:ring-0 placeholder:text-muted-foreground/30 placeholder:tracking-widest"
                          autoFocus
                        />
                        
                        {/* Input Underline Animation */}
                        <div className={`absolute bottom-0 left-0 h-[2px] bg-gradient-to-r from-primary to-cyan-500 transition-all duration-500 ${isFocused ? 'w-full' : 'w-0'}`} />
                      </div>
                      
                      {/* Status Indicator */}
                      <div className={`w-3 h-3 rounded-full transition-colors duration-300 ${accessCode.length > 0 ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30'}`} />
                    </div>
                  </div>
                </div>

                {/* Submit Button */}
                <div className="relative group/btn">
                  {/* Button Glow */}
                  <div className="absolute -inset-2 bg-gradient-to-r from-primary via-cyan-500 to-blue-500 rounded-xl blur-xl opacity-40 group-hover/btn:opacity-60 transition-opacity animate-pulse-slow" />
                  
                  <Button 
                    type="submit" 
                    className="relative w-full h-16 text-base font-black tracking-widest rounded-xl bg-gradient-to-r from-primary via-cyan-500 to-blue-500 hover:from-primary hover:via-cyan-400 hover:to-blue-400 shadow-2xl hover:shadow-primary/50 hover:scale-[1.02] active:scale-[0.98] transition-all duration-300 border-0 overflow-hidden"
                    disabled={isLoading}
                  >
                    {/* Animated Background */}
                    <div className="absolute inset-0 bg-[linear-gradient(45deg,transparent_25%,rgba(255,255,255,0.1)_50%,transparent_75%)] bg-[length:250%_250%] animate-shimmer" />
                    
                    {/* Scan Line */}
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-white/10 to-transparent animate-scan-button" />
                    
                    {isLoading ? (
                      <div className="flex items-center gap-4">
                        <div className="relative w-6 h-6">
                          <div className="absolute inset-0 border-3 border-white/30 rounded-full" />
                          <div className="absolute inset-0 border-3 border-t-white rounded-full animate-spin" />
                        </div>
                        <span>AUTHENTICATING...</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-4">
                        <Lock className="w-5 h-5" />
                        <span>INITIALIZE ACCESS</span>
                        <Zap className="w-5 h-5 animate-pulse" />
                      </div>
                    )}
                  </Button>
                </div>
              </form>

              {/* Status Footer */}
              <div className="mt-10 pt-6 border-t border-border/30">
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div className="space-y-1">
                    <ShieldCheck className="w-5 h-5 mx-auto text-green-500" />
                    <p className="text-[10px] text-muted-foreground font-mono">ENCRYPTED</p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-center gap-0.5">
                      {[...Array(5)].map((_, i) => (
                        <div
                          key={i}
                          className="w-1 bg-primary rounded-full animate-equalizer"
                          style={{
                            height: `${8 + Math.random() * 12}px`,
                            animationDelay: `${i * 0.1}s`,
                          }}
                        />
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground font-mono">ACTIVE</p>
                  </div>
                  <div className="space-y-1">
                    <Wifi className="w-5 h-5 mx-auto text-cyan-500 animate-pulse" />
                    <p className="text-[10px] text-muted-foreground font-mono">CONNECTED</p>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Bottom Progress Bar */}
            <div className="h-1 bg-muted/30 overflow-hidden">
              <div className="h-full w-1/3 bg-gradient-to-r from-primary via-cyan-500 to-blue-500 animate-progress-loop" />
            </div>
          </div>
        </div>

        {/* System Info */}
        <div className="mt-8 text-center space-y-1">
          <p className="text-[10px] text-muted-foreground/60 font-mono tracking-widest">
            SYSTEM ID: SEC-{Math.random().toString(36).substring(2, 8).toUpperCase()}
          </p>
          <p className="text-[10px] text-muted-foreground/40 font-mono">
            AES-256 • RSA-4096 • ZERO-KNOWLEDGE
          </p>
        </div>
      </div>

      {/* Advanced Animations */}
      <style>{`
        @keyframes matrix-fall {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        
        @keyframes float-rotate {
          0%, 100% { transform: translateY(0) rotate(0deg); }
          50% { transform: translateY(-20px) rotate(10deg); }
        }
        
        @keyframes scan-vertical {
          0% { top: -10%; }
          100% { top: 110%; }
        }
        
        @keyframes scan-horizontal {
          0% { left: -10%; }
          100% { left: 110%; }
        }
        
        @keyframes radar {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        @keyframes spin-very-slow {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        @keyframes border-flow {
          0% { filter: hue-rotate(0deg); }
          100% { filter: hue-rotate(360deg); }
        }
        
        @keyframes scan-biometric {
          0%, 100% { transform: translateY(-100%); }
          50% { transform: translateY(100%); }
        }
        
        @keyframes float-up {
          0% { opacity: 1; transform: translateY(0); }
          100% { opacity: 0; transform: translateY(-50px); }
        }
        
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        
        @keyframes scan-button {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100%); }
        }
        
        @keyframes equalizer {
          0%, 100% { height: 8px; }
          50% { height: 20px; }
        }
        
        @keyframes progress-loop {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
        
        @keyframes spin-slow {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        
        @keyframes pulse-slow {
          0%, 100% { opacity: 0.3; }
          50% { opacity: 0.8; }
        }
        
        .animate-matrix-fall { animation: matrix-fall linear infinite; }
        .animate-float-rotate { animation: float-rotate 6s ease-in-out infinite; }
        .animate-scan-vertical { animation: scan-vertical 4s linear infinite; }
        .animate-scan-horizontal { animation: scan-horizontal 5s linear infinite; }
        .animate-radar { animation: radar 4s linear infinite; }
        .animate-spin-very-slow { animation: spin-very-slow 30s linear infinite; }
        .animate-border-flow { animation: border-flow 6s linear infinite; }
        .animate-scan-biometric { animation: scan-biometric 2s ease-in-out infinite; }
        .animate-float-up { animation: float-up 1s ease-out forwards; }
        .animate-shimmer { animation: shimmer 3s linear infinite; }
        .animate-scan-button { animation: scan-button 2s linear infinite; }
        .animate-equalizer { animation: equalizer 0.8s ease-in-out infinite; }
        .animate-progress-loop { animation: progress-loop 2s linear infinite; }
        .animate-spin-slow { animation: spin-slow 20s linear infinite; }
        .animate-pulse-slow { animation: pulse-slow 3s ease-in-out infinite; }
        
        .glitch-text {
          position: relative;
        }
        
        .glitch-text::before,
        .glitch-text::after {
          content: attr(data-text);
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
        }
        
        .glitch-text::before {
          animation: glitch-1 2s infinite linear alternate-reverse;
          clip-path: polygon(0 0, 100% 0, 100% 35%, 0 35%);
          color: hsl(var(--primary));
        }
        
        .glitch-text::after {
          animation: glitch-2 3s infinite linear alternate-reverse;
          clip-path: polygon(0 65%, 100% 65%, 100% 100%, 0 100%);
          color: hsl(195 100% 50%);
        }
        
        @keyframes glitch-1 {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-2px); }
          40% { transform: translateX(2px); }
          60% { transform: translateX(-1px); }
          80% { transform: translateX(1px); }
        }
        
        @keyframes glitch-2 {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(2px); }
          40% { transform: translateX(-2px); }
          60% { transform: translateX(1px); }
          80% { transform: translateX(-1px); }
        }
        
        .bg-gradient-conic {
          background: conic-gradient(from 0deg, var(--tw-gradient-stops));
        }
        
        .perspective-1000 {
          perspective: 1000px;
        }
      `}</style>
    </div>
  );
};

export default Login;
