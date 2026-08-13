import { Component } from "react";

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
        <div className="loom-card loom-card-error">
          <h3 className="loom-title-sm">Something went wrong</h3>
          <p className="loom-text loom-text-muted">
            {this.props.fallbackMessage || "An error occurred rendering this component."}
          </p>
          {this.state.error && (
            <pre className="loom-error-trace">
              {this.state.error.message}
            </pre>
          )}
          <button
            className="pure-button pure-button-primary loom-mt-sm"
            onClick={this.handleRetry}
          >
            Try again
          </button>
        </div>
      );
    }
    return <div key={this.state.resetKey}>{this.props.children}</div>;
  }
}
