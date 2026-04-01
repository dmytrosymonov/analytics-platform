import { SourceConnector } from './base/connector.interface';
import { GTOConnector } from './gto/gto.connector';
import { GTOCommentsConnector } from './gto-comments/gto-comments.connector';
import { GA4Connector } from './ga4/ga4.connector';
import { RedmineConnector } from './redmine/redmine.connector';
import { YouTrackConnector } from './youtrack/youtrack.connector';
import { YouTrackProgressConnector } from './youtrack/youtrack-progress.connector';

class ConnectorRegistry {
  private connectors = new Map<string, SourceConnector>([
    ['gto', new GTOConnector()],
    ['gto_comments', new GTOCommentsConnector()],
    ['ga4', new GA4Connector()],
    ['redmine', new RedmineConnector()],
    ['youtrack', new YouTrackConnector()],
    ['youtrack_progress', new YouTrackProgressConnector()],
  ]);

  get(type: string): SourceConnector {
    const connector = this.connectors.get(type);
    if (!connector) throw new Error(`No connector for source type: ${type}`);
    return connector;
  }
}

export const connectorRegistry = new ConnectorRegistry();
