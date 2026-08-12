import { Component } from "react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

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
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
