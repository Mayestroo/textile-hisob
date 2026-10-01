import { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Copy, Check } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    copied: false
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, copied: false };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught React Error:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleCopy = () => {
    if (this.state.error) {
      navigator.clipboard.writeText(`${this.state.error.name}: ${this.state.error.message}\n${this.state.error.stack || ''}`);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            height: '100vh',
            width: '100vw',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#0f172a',
            color: '#f8fafc',
            padding: '24px',
            boxSizing: 'border-box',
            fontFamily: 'Inter, system-ui, sans-serif'
          }}
        >
          <div
            style={{
              maxWidth: '560px',
              width: '100%',
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '16px',
              padding: '32px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)',
              textAlign: 'center'
            }}
          >
            <div
              style={{
                width: '60px',
                height: '60px',
                borderRadius: '50%',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 20px',
                border: '1px solid rgba(239, 68, 68, 0.3)'
              }}
            >
              <AlertTriangle size={32} color="#ef4444" />
            </div>

            <h2 style={{ fontSize: '20px', fontWeight: 700, marginBottom: '12px', color: '#fff' }}>
              Dasturda kutilmagan xatolik yuz berdi
            </h2>

            <p style={{ fontSize: '13.5px', color: '#94a3b8', lineHeight: 1.6, marginBottom: '20px' }}>
              Xavotir olmang, barcha ma'lumotlar bazada xavfsiz saqlangan. Quyidagi tugma orqali dasturni qayta yuklashingiz mumkin.
            </p>

            {this.state.error && (
              <div
                style={{
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '12px 14px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  color: '#f87171',
                  textAlign: 'left',
                  maxHeight: '120px',
                  overflowY: 'auto',
                  marginBottom: '24px',
                  wordBreak: 'break-all'
                }}
              >
                {this.state.error.message}
              </div>
            )}

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button
                onClick={this.handleReload}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 20px',
                  borderRadius: '9999px',
                  backgroundColor: '#059669',
                  color: '#fff',
                  fontWeight: 600,
                  fontSize: '13px',
                  border: 'none',
                  cursor: 'pointer'
                }}
              >
                <RefreshCw size={15} />
                <span>Qayta yuklash</span>
              </button>

              <button
                onClick={this.handleCopy}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 18px',
                  borderRadius: '9999px',
                  backgroundColor: '#334155',
                  color: '#cbd5e1',
                  fontWeight: 600,
                  fontSize: '13px',
                  border: '1px solid #475569',
                  cursor: 'pointer'
                }}
              >
                {this.state.copied ? <Check size={15} color="#10b981" /> : <Copy size={15} />}
                <span>{this.state.copied ? 'Nusxalandi' : 'Xatoni nusxalash'}</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
