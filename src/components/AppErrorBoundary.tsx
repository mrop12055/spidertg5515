import React from "react";

type AppErrorBoundaryState = {
  error: Error | null;
};

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[AppErrorBoundary] renderer crashed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <section className="w-full max-w-2xl rounded-lg border border-border bg-card p-6 shadow-lg">
          <h1 className="text-2xl font-semibold mb-3">App failed to start</h1>
          <p className="text-muted-foreground mb-4">
            Rebuild the desktop app with the latest files. If this appears again, open DevTools and copy the console error.
          </p>
          <pre className="max-h-80 overflow-auto rounded-md bg-muted p-4 text-sm text-muted-foreground whitespace-pre-wrap">
            {this.state.error.stack || this.state.error.message}
          </pre>
        </section>
      </main>
    );
  }
}