import { Component } from "react";
import { Alert, AlertTitle, AlertDescription } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card.tsx";
import { TriangleAlertIcon } from "lucide-react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: 0 };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error(`[Loom ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`, error, errorInfo.componentStack);
  }

  handleRetry = () => {
    this.setState((s) => ({ hasError: false, error: null, resetKey: s.resetKey + 1 }));
  };

  render() {
    if (this.state.hasError) {
      return (
        <Alert variant="destructive" className="my-2">
          <TriangleAlertIcon />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{this.props.fallbackMessage || "An error occurred rendering this component."}</span>
            {this.state.error && (
              <pre className="text-xs bg-destructive/10 p-2 rounded whitespace-pre-wrap break-words">
                {this.state.error.message}
              </pre>
            )}
            <Button variant="outline" size="sm" onClick={this.handleRetry} className="w-fit">
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return <div key={this.state.resetKey}>{this.props.children}</div>;
  }
}
