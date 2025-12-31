import React, { useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { cn } from '@/lib/utils';
import { Upload, FileArchive, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { Progress } from '@/components/ui/progress';

interface FileUploadZoneProps {
  onFilesSelected: (files: File[]) => void;
  accept?: Record<string, string[]>;
  maxFiles?: number;
  label?: string;
  description?: string;
  isUploading?: boolean;
  progress?: {
    total: number;
    processed: number;
    successful: number;
    failed: number;
  };
  className?: string;
}

export const FileUploadZone: React.FC<FileUploadZoneProps> = ({
  onFilesSelected,
  accept = {
    'application/zip': ['.zip'],
    'application/json': ['.json'],
    'application/x-sqlite3': ['.session']
  },
  maxFiles = 10,
  label = 'Drop files here',
  description = 'or click to browse',
  isUploading = false,
  progress,
  className
}) => {
  const onDrop = useCallback((acceptedFiles: File[]) => {
    onFilesSelected(acceptedFiles);
  }, [onFilesSelected]);

  const { getRootProps, getInputProps, isDragActive, acceptedFiles } = useDropzone({
    onDrop,
    accept,
    maxFiles,
    disabled: isUploading
  });

  const progressPercent = progress 
    ? Math.round((progress.processed / progress.total) * 100) 
    : 0;

  return (
    <div className={cn("space-y-4", className)}>
      <div
        {...getRootProps()}
        className={cn(
          "relative border-2 border-dashed rounded-xl p-8 transition-all duration-200 cursor-pointer",
          "hover:border-primary/50 hover:bg-primary/5",
          isDragActive && "border-primary bg-primary/10 scale-[1.02]",
          isUploading && "pointer-events-none opacity-60",
          "border-border bg-card/50"
        )}
      >
        <input {...getInputProps()} />
        
        <div className="flex flex-col items-center text-center">
          <div className={cn(
            "w-16 h-16 rounded-2xl flex items-center justify-center mb-4 transition-transform duration-200",
            isDragActive ? "scale-110 gradient-primary" : "bg-secondary",
          )}>
            {isDragActive ? (
              <FileArchive className="w-8 h-8 text-primary-foreground" />
            ) : (
              <Upload className="w-8 h-8 text-muted-foreground" />
            )}
          </div>
          
          <p className="text-lg font-semibold text-foreground">{label}</p>
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
          
          <div className="flex flex-wrap gap-2 mt-4 justify-center">
            <span className="px-2 py-1 rounded-md bg-secondary text-xs font-medium text-muted-foreground">
              ZIP
            </span>
            <span className="px-2 py-1 rounded-md bg-secondary text-xs font-medium text-muted-foreground">
              JSON
            </span>
            <span className="px-2 py-1 rounded-md bg-secondary text-xs font-medium text-muted-foreground">
              SESSION
            </span>
          </div>
        </div>
      </div>

      {/* Progress */}
      {isUploading && progress && (
        <div className="space-y-3 p-4 rounded-xl bg-card border border-border animate-fade-in">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Processing accounts...</span>
            <span className="font-medium text-foreground">{progressPercent}%</span>
          </div>
          
          <Progress value={progressPercent} className="h-2" />
          
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-status-active" />
              <span className="text-muted-foreground">
                {progress.successful} successful
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-status-banned" />
              <span className="text-muted-foreground">
                {progress.failed} failed
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Selected Files */}
      {acceptedFiles.length > 0 && !isUploading && (
        <div className="space-y-2">
          {acceptedFiles.map((file, i) => (
            <div 
              key={i}
              className="flex items-center gap-3 p-3 rounded-lg bg-card border border-border animate-slide-in-up"
            >
              <FileArchive className="w-5 h-5 text-primary" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                <p className="text-xs text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
