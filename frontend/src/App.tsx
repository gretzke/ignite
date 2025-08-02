import { useState, useEffect, useRef, useCallback } from 'react';
import './App.css';

interface Message {
  type: string;
  message: string;
}

type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting';

type DetectionState = 'loading' | 'detected' | 'not-detected' | 'error';

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting');
  const [detectionState, setDetectionState] =
    useState<DetectionState>('loading');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectRef = useRef<(() => void) | null>(null);
  const maxReconnectAttempts = 10;
  const baseReconnectDelay = 1000; // 1 second

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      console.log('❌ Max reconnection attempts reached');
      return;
    }

    clearReconnectTimeout();

    const delay = Math.min(
      baseReconnectDelay * Math.pow(2, reconnectAttemptsRef.current),
      30000 // Max 30 seconds
    );

    setConnectionState('reconnecting');
    reconnectAttemptsRef.current += 1;

    console.log(
      `🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts})`
    );

    reconnectTimeoutRef.current = setTimeout(() => {
      connectRef.current?.();
    }, delay);
  }, [clearReconnectTimeout]);

  const connect = useCallback(() => {
    // Don't create multiple connections
    if (
      wsRef.current?.readyState === WebSocket.CONNECTING ||
      wsRef.current?.readyState === WebSocket.OPEN
    ) {
      return;
    }

    setConnectionState('connecting');

    try {
      const ws = new WebSocket(`ws://localhost:3000/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionState('connected');
        reconnectAttemptsRef.current = 0;
        console.log('✅ Connected to WebSocket');
      };

      ws.onmessage = (event) => {
        try {
          const data: Message = JSON.parse(event.data);
          setMessages((prev) => [...prev, data]);
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      };

      ws.onclose = (event) => {
        setConnectionState('disconnected');
        console.log(
          '❌ WebSocket connection closed:',
          event.code,
          event.reason
        );

        // Attempt to reconnect unless it was a manual close
        if (event.code !== 1000) {
          scheduleReconnect();
        }
      };

      ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error);
        setConnectionState('disconnected');
      };
    } catch (err) {
      console.error('❌ Failed to create WebSocket:', err);
      setConnectionState('disconnected');
      scheduleReconnect();
    }
  }, [scheduleReconnect]);

  const detectFoundry = useCallback(async () => {
    setDetectionState('loading');
    try {
      const response = await fetch('/api/detect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}), // Use pre-mounted workspace from CLI startup
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const isFoundryDetected =
        data.result?.success && data.result?.data === true;

      setDetectionState(isFoundryDetected ? 'detected' : 'not-detected');
    } catch (error) {
      console.error('Failed to detect Foundry:', error);
      setDetectionState('error');
    }
  }, []);

  // Keep connectRef up to date
  connectRef.current = connect;

  // Initial connection and cleanup
  useEffect(() => {
    connect();

    return () => {
      clearReconnectTimeout();
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounting');
      }
    };
  }, [connect, clearReconnectTimeout]);

  // Detect Foundry when app loads
  useEffect(() => {
    detectFoundry();
  }, [detectFoundry]);

  const sendMessage = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN && inputMessage.trim()) {
      wsRef.current.send(inputMessage);
      setInputMessage('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  };

  const getStatusDisplay = () => {
    switch (connectionState) {
      case 'connecting':
        return '🟡 Connecting to backend...';
      case 'connected':
        return '🟢 Connected';
      case 'disconnected':
        return '🔴 Disconnected';
      case 'reconnecting':
        return `🟡 Reconnecting... (attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts})`;
      default:
        return '❓ Unknown';
    }
  };

  const getDetectionDisplay = () => {
    switch (detectionState) {
      case 'loading':
        return '🔄 Detecting project type...';
      case 'detected':
        return '⚒️ Foundry project detected';
      case 'not-detected':
        return '📁 No Foundry project detected';
      case 'error':
        return '❌ Detection failed';
      default:
        return '❓ Unknown';
    }
  };

  const canSendMessages = connectionState === 'connected';

  return (
    <div className="App">
      <header className="App-header">
        <h1>🚀 Ignite</h1>
        <p>Smart Contract Deployment Tool</p>
        <div className={`status ${connectionState}`}>
          Status: {getStatusDisplay()}
        </div>
        <div className={`detection ${detectionState}`}>
          Project: {getDetectionDisplay()}
        </div>
        {connectionState === 'disconnected' &&
          reconnectAttemptsRef.current >= maxReconnectAttempts && (
            <div className="reconnect-controls">
              <button
                onClick={() => {
                  reconnectAttemptsRef.current = 0;
                  connect();
                }}
              >
                Retry Connection
              </button>
            </div>
          )}
      </header>

      <main>
        <div className="messages-container">
          <h3>Messages:</h3>
          <div className="messages">
            {messages.length === 0 && connectionState === 'connecting' && (
              <div className="message info">
                <strong>Info:</strong> Waiting for backend to start...
              </div>
            )}
            {messages.map((msg, index) => (
              <div key={index} className={`message ${msg.type}`}>
                <strong>{msg.type}:</strong> {msg.message}
              </div>
            ))}
          </div>
        </div>

        <div className="input-container">
          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={
              canSendMessages
                ? 'Type a message...'
                : 'Waiting for connection...'
            }
            disabled={!canSendMessages}
          />
          <button onClick={sendMessage} disabled={!canSendMessages}>
            Send
          </button>
        </div>

        {connectionState === 'disconnected' && (
          <div className="connection-help">
            <p>
              💡 <strong>Connection lost:</strong> Make sure the backend is
              running on port 3000
            </p>
            <p>
              🔄 The app will automatically reconnect when the backend is
              available
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
