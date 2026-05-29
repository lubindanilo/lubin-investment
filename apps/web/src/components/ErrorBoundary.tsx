import { Component, type ReactNode } from 'react';
import { captureException } from '../lib/sentry.js';
import './ErrorBoundary.css';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
    captureException(error, { componentStack: info.componentStack });
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h1>Erreur dans l'application</h1>
          <p className="error-boundary-msg">{this.state.error.message}</p>
          <p className="error-boundary-hint">
            L'erreur a été enregistrée. Recharge la page ou retourne à l'accueil.
          </p>
          <div className="error-boundary-actions">
            <button className="btn-secondary" onClick={() => location.reload()}>Recharger</button>
            <button className="btn-primary" onClick={this.reset}>Réessayer</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
