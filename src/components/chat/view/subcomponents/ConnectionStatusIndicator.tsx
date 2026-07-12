import { useTranslation } from 'react-i18next';

import { useWebSocket } from '../../../../contexts/WebSocketContext';

/**
 * Text-only connection-status indicator. Hidden entirely once the socket is
 * connected; otherwise shows a short label (full text at sm+, icon-free
 * abbreviated text below that breakpoint) matching the neighboring toolbar
 * chips' shrink-0/whitespace-nowrap treatment so it doesn't wrap or get
 * squeezed in an unconstrained flex row.
 */
export default function ConnectionStatusIndicator() {
  const { t } = useTranslation('chat');
  const { connectionState } = useWebSocket();

  if (connectionState === 'connected') return null;

  return (
    <span
      className={`shrink-0 whitespace-nowrap text-xs font-medium ${connectionState === 'reconnecting' ? 'text-yellow-600 dark:text-yellow-400' : 'text-destructive'}`}
    >
      {connectionState === 'reconnecting' ? t('input.connectionStatus.reconnecting') : t('input.connectionStatus.disconnected')}
    </span>
  );
}
