import React, { Component, type ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';
import { isChunkLoadError, recoverFromChunkLoadError } from '../../utils/app-version';

interface Props extends WithTranslation {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundaryInner extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    if (isChunkLoadError(error)) {
      recoverFromChunkLoadError();
    }
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.fallbackLabel || 'App error', error, errorInfo.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    const { t } = this.props;
    if (this.state.hasError) {
      return (
        <div role="alert" className="flex flex-col items-center justify-center h-full gap-3 p-6 text-center">
          <div className="text-red-400 text-xl font-semibold">
            {this.props.fallbackLabel || t('somethingWentWrong')}
          </div>
          <details className="text-sm text-gray-500 max-w-md">
            <summary className="cursor-pointer hover:text-gray-400 transition-colors">{t('errorDetails')}</summary>
            <pre className="mt-2 p-2 bg-surface-900 rounded text-left overflow-auto break-all max-h-32">
              {this.state.error?.message}
            </pre>
          </details>
          <button
            onClick={this.handleReset}
            className="mt-2 px-4 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-500 rounded-lg transition-colors cursor-pointer"
          >
            {t('retry')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export const ErrorBoundary = withTranslation('common')(ErrorBoundaryInner);
