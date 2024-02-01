import { DebugLogger } from '@affine/debug';
import { fetchWithTraceReport } from '@affine/graphql';
import { type SyncStorage } from '@toeverything/infra';
import type { CleanupService } from '@toeverything/infra/lifecycle';

import { getIoManager } from '../utils/affine-io';
import { base64ToUint8Array, uint8ArrayToBase64 } from '../utils/base64';

const logger = new DebugLogger('affine:storage:socketio');

export class AffineSyncStorage implements SyncStorage {
  name = 'affine-cloud';

  SEND_TIMEOUT = 30000;

  socket = getIoManager().socket('/');

  constructor(
    private readonly workspaceId: string,
    cleanupService: CleanupService
  ) {
    this.socket.on('connect', this.handleConnect);

    if (this.socket.connected) {
      this.socket.emit('client-handshake-sync', this.workspaceId);
    } else {
      this.socket.connect();
    }

    cleanupService.add(() => {
      this.cleanup();
    });
  }

  handleConnect = () => {
    this.socket.emit('client-handshake-sync', this.workspaceId);
  };

  async pull(
    docId: string,
    state: Uint8Array
  ): Promise<{ data: Uint8Array; state?: Uint8Array } | null> {
    const stateVector = state ? await uint8ArrayToBase64(state) : undefined;

    logger.debug('doc-load-v2', {
      workspaceId: this.workspaceId,
      guid: docId,
      stateVector,
    });

    const response:
      | { error: any }
      | { data: { missing: string; state: string } } = await this.socket
      .timeout(this.SEND_TIMEOUT)
      .emitWithAck('doc-load-v2', {
        workspaceId: this.workspaceId,
        guid: docId,
        stateVector,
      });

    logger.debug('doc-load callback', {
      workspaceId: this.workspaceId,
      guid: docId,
      stateVector,
      response,
    });

    if ('error' in response) {
      // TODO: result `EventError` with server
      if (response.error.code === 'DOC_NOT_FOUND') {
        return null;
      } else {
        throw new Error(response.error.message);
      }
    } else {
      return {
        data: base64ToUint8Array(response.data.missing),
        state: response.data.state
          ? base64ToUint8Array(response.data.state)
          : undefined,
      };
    }
  }

  async push(docId: string, update: Uint8Array) {
    logger.debug('client-update-v2', {
      workspaceId: this.workspaceId,
      guid: docId,
      update,
    });

    const payload = await uint8ArrayToBase64(update);

    const response: {
      // TODO: reuse `EventError` with server
      error?: any;
      data: any;
    } = await this.socket
      .timeout(this.SEND_TIMEOUT)
      .emitWithAck('client-update-v2', {
        workspaceId: this.workspaceId,
        guid: docId,
        updates: [payload],
      });

    // TODO: raise error with different code to users
    if (response.error) {
      logger.error('client-update-v2 error', {
        workspaceId: this.workspaceId,
        guid: docId,
        response,
      });

      throw new Error(response.error);
    }
  }

  async subscribe(
    cb: (docId: string, data: Uint8Array) => void,
    disconnect: (reason: string) => void
  ) {
    const handleUpdate = async (message: {
      workspaceId: string;
      guid: string;
      updates: string[];
    }) => {
      if (message.workspaceId === this.workspaceId) {
        message.updates.forEach(update => {
          cb(message.guid, base64ToUint8Array(update));
        });
      }
    };
    const handleDisconnect = (reason: string) => {
      this.socket.off('server-updates', handleUpdate);
      disconnect(reason);
    };
    this.socket.on('server-updates', handleUpdate);

    this.socket.on('disconnect', handleDisconnect);

    return () => {
      this.socket.off('server-updates', handleUpdate);
      this.socket.off('disconnect', handleDisconnect);
    };
  }

  cleanup() {
    this.socket.emit('client-leave-sync', this.workspaceId);
    this.socket.off('connect', this.handleConnect);
  }
}

export class AffineStaticSyncStorage implements SyncStorage {
  name = 'affine-cloud-static';
  constructor(private readonly workspaceId: string) {}

  async pull(
    docId: string
  ): Promise<{ data: Uint8Array; state?: Uint8Array | undefined } | null> {
    const response = await fetchWithTraceReport(
      `/api/workspaces/${this.workspaceId}/docs/${docId}`,
      {
        priority: 'high',
      }
    );
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();

      return { data: new Uint8Array(arrayBuffer) };
    }

    return null;
  }
  push(): Promise<void> {
    throw new Error('Method not implemented.');
  }
  subscribe(): Promise<() => void> {
    throw new Error('Method not implemented.');
  }
}