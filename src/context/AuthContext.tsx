import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { Admin } from '@/types/telegram';

interface AuthContextType {
  user: Admin | null;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  isSuperAdmin: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Mock admins for demo
const mockAdmins: Admin[] = [
  {
    id: '1',
    email: 'superadmin@telegram.com',
    name: 'Super Admin',
    role: 'super_admin',
    status: 'active',
    createdAt: new Date('2024-01-01'),
    lastLogin: new Date(),
    accountsManaged: 300
  },
  {
    id: '2',
    email: 'admin@telegram.com',
    name: 'Admin User',
    role: 'admin',
    status: 'active',
    createdAt: new Date('2024-06-01'),
    lastLogin: new Date(),
    accountsManaged: 150
  }
];

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<Admin | null>(() => {
    // Auto-login as super admin for demo
    return mockAdmins[0];
  });

  const login = useCallback(async (email: string, password: string): Promise<boolean> => {
    // Mock authentication - replace with real API call
    const foundAdmin = mockAdmins.find(a => a.email === email);
    if (foundAdmin && password === 'admin123') {
      setUser(foundAdmin);
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(() => {
    setUser(null);
  }, []);

  const value: AuthContextType = {
    user,
    isAuthenticated: !!user,
    login,
    logout,
    isSuperAdmin: user?.role === 'super_admin'
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
