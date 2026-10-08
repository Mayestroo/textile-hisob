'use strict';

const { resolveApiBaseUrl } = require('../apiConfig.cjs');

const DEFAULT_MAX_OPERATION_BATCH_BYTES = 48 * 1024;

/**
 * Isolated Authoritative Sync Client for Electron Main.
 * Phase 2 — Step 4: Authoritative Distributed Synchronization & Leases
 *
 * Handles HTTP transport, header injection, authentication, and error classification.
 */

class SyncError extends Error {
  constructor(message, code, statusCode, details = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

class SyncNetworkError extends SyncError {
  constructor(message, originalError = null) {
    super(message, 'NETWORK_ERROR', 0, { originalMessage: originalError?.message });
    this.name = 'SyncNetworkError';
    this.isTransient = true;
  }
}

class SyncClient {
  constructor(config = {}) {
    this.baseUrl = resolveApiBaseUrl({ baseUrl: config.baseUrl, env: process.env, allowHttp: config.allowHttp === true });
    this.token = config.token || '';
    this.operatorToken = config.operatorToken || '';
    this.deviceId = config.deviceId || 'electron-workstation';
    this.clientVersion = config.clientVersion || '1.0.0';
    this.timeoutMs = config.timeoutMs || 10000;
    this.maxOperationBatchBytes = Number.isSafeInteger(config.maxOperationBatchBytes)
      && config.maxOperationBatchBytes > 0
      ? config.maxOperationBatchBytes
      : DEFAULT_MAX_OPERATION_BATCH_BYTES;
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'x-device-id': this.deviceId,
      'x-client-version': this.clientVersion
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (this.operatorToken) headers['x-operator-token'] = this.operatorToken;
    return headers;
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (err) {
      clearTimeout(id);
      if (err.name === 'AbortError') {
        throw new SyncNetworkError(`Request timed out after ${timeoutMs}ms`, err);
      }
      throw new SyncNetworkError(`Network request failed: ${err.message}`, err);
    }
  }

  async healthCheck() {
    const url = `${this.baseUrl}/api/health`;
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) {
      throw new SyncError('Health check failed', 'HEALTH_FAILED', res.status);
    }
    return res.json();
  }

  async pushOperations(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      return { success: true, results: [] };
    }

    const results = [];
    let standardOperations = [];
    const requestBytes = (batch) => Buffer.byteLength(JSON.stringify({ operations: batch }), 'utf8');
    const pushStandardBatch = async (batch) => {
      if (!batch.length) return;
      try {
        const response = await this.pushOperationBatch(batch);
        results.push(...response.results);
      } catch (error) {
        if (error?.statusCode === 413) {
          if (batch.length > 1) {
            const split = Math.ceil(batch.length / 2);
            await pushStandardBatch(batch.slice(0, split));
            await pushStandardBatch(batch.slice(split));
            return;
          }
          results.push({
            operationId: batch[0].operationId,
            status: 'REJECTED',
            error: { code: 'REQUEST_PAYLOAD_TOO_LARGE', message: 'A single operation exceeds the server request-size limit' }
          });
          return;
        }
        throw error;
      }
    };
    const flushStandardOperations = async () => {
      if (!standardOperations.length) return;
      const batch = standardOperations;
      standardOperations = [];
      await pushStandardBatch(batch);
    };

    for (const operation of operations) {
      if (operation?.commandType === 'CreateWorker') {
        await flushStandardOperations();
        results.push(await this.createWorker(operation));
      } else {
        if (standardOperations.length > 0
          && requestBytes([...standardOperations, operation]) > this.maxOperationBatchBytes) {
          await flushStandardOperations();
        }
        standardOperations.push(operation);
        if (requestBytes(standardOperations) >= this.maxOperationBatchBytes) {
          await flushStandardOperations();
        }
      }
    }
    await flushStandardOperations();
    return { success: true, results };
  }

  async getOperationStatuses(operations) {
    if (!Array.isArray(operations) || operations.length === 0) return { success: true, results: [] };
    const url = `${this.baseUrl}/api/sync/operations/status`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({ operations })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SyncError(
        data.error?.message || 'Operation status reconciliation failed',
        data.error?.code || `OPERATION_STATUS_HTTP_${res.status}`,
        res.status,
        data.error
      );
    }
    return data;
  }

  async pushOperationBatch(operations) {
    if (!Array.isArray(operations) || operations.length === 0) return { success: true, results: [] };

    const url = `${this.baseUrl}/api/sync/operations`;
    let res;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ operations })
      });
    } catch (netErr) {
      throw netErr;
    }

    const data = await res.json().catch(() => ({}));

    if (res.status === 426) {
      throw new SyncError(
        data.error?.message || 'Client version upgrade required',
        'CLIENT_VERSION_TOO_OLD',
        426,
        data.error
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new SyncError(
        data.error?.message || 'Authorization failed',
        data.error?.code || 'AUTH_REJECTED',
        res.status,
        data.error
      );
    }

    if (res.status === 413) {
      throw new SyncError(
        data.error?.message || 'Operation batch exceeds the server request-size limit',
        data.error?.code || 'REQUEST_BODY_TOO_LARGE',
        res.status,
        data.error
      );
    }

    if (!res.ok && res.status >= 500) {
      const err = new SyncNetworkError(`Server returned HTTP ${res.status}: ${data.error?.message || 'Internal error'}`);
      err.statusCode = res.status;
      throw err;
    }

    if (!res.ok) {
      throw new SyncError(
        data.error?.message || `Operation batch failed with HTTP ${res.status}`,
        data.error?.code || `OPERATION_HTTP_${res.status}`,
        res.status,
        data.error
      );
    }

    if (data.success !== true || !Array.isArray(data.results)) {
      throw new SyncError(
        data.error?.message || 'Server response did not include per-operation results',
        data.error?.code || 'INVALID_OPERATION_BATCH_RESPONSE',
        502,
        data.error
      );
    }

    const expectedIds = new Set(operations.map((operation) => String(operation.operationId)));
    const resultIds = new Set();
    for (const result of data.results) {
      const operationId = typeof result?.operationId === 'string' ? result.operationId : '';
      if (!expectedIds.has(operationId) || resultIds.has(operationId)) {
        throw new SyncError('Server returned duplicate or unexpected operation results', 'INVALID_OPERATION_BATCH_RESPONSE', 502);
      }
      resultIds.add(operationId);
    }
    if (resultIds.size !== expectedIds.size) {
      throw new SyncError('Server returned an incomplete operation-results batch', 'INCOMPLETE_OPERATION_BATCH_RESPONSE', 502);
    }

    return data;
  }

  async createWorker(operation) {
    const operationId = String(operation?.operationId || '').trim();
    const payload = operation?.payload || {};
    const body = {
      operationId,
      name: payload.name,
      staj: payload.staj,
      role: payload.role,
      balanceAdjustments: payload.balanceAdjustments || []
    };
    const response = await this.fetchWithTimeout(`${this.baseUrl}/api/workers`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 426) {
      throw new SyncError(data.error?.message || 'Client version upgrade required', 'CLIENT_VERSION_TOO_OLD', 426, data.error);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SyncError(data.error?.message || 'Authorization failed', data.error?.code || 'AUTH_REJECTED', response.status, data.error);
    }
    if (!response.ok && response.status >= 500) {
      const error = new SyncNetworkError(`Server returned HTTP ${response.status}: ${data.error?.message || 'Internal error'}`);
      error.statusCode = response.status;
      throw error;
    }
    if (!response.ok || data.success !== true) {
      const status = data.error?.code === 'IDEMPOTENCY_CONFLICT' ? 'CONFLICT' : 'REJECTED';
      return { operationId, status, error: data.error || { code: 'WORKER_CREATE_REJECTED' } };
    }

    const worker = data.worker;
    const workerId = Number(worker?.id);
    if (data.operationId !== operationId || !Number.isSafeInteger(workerId) || workerId <= 0) {
      throw new SyncError('Server returned an invalid canonical worker ID', 'INVALID_SERVER_WORKER_ID', 502);
    }
    return {
      operationId,
      status: 'APPLIED',
      entityId: String(workerId),
      serverRevision: Number(data.serverRevision || 1),
      cursor: data.cursor || null,
      committedAt: data.committedAt,
      isReplay: data.replay === true,
      worker
    };
  }

  async loginOperator(operatorId, password) {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/auth/operator/login`, {
      method: 'POST', headers: this.getHeaders(), body: JSON.stringify({ operatorId, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SyncError(data.error?.message || 'Operator login failed', data.error?.code || 'OPERATOR_AUTH_REJECTED', res.status, data.error);
    return data.session;
  }

  async revokeOperator() {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/auth/operator/revoke`, { method: 'POST', headers: this.getHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SyncError(data.error?.message || 'Operator revoke failed', data.error?.code || 'OPERATOR_REVOKE_FAILED', res.status, data.error);
    return data;
  }

  async pullChanges(cursor = 0, limit = 100) {
    const url = `${this.baseUrl}/api/sync/changes?cursor=${encodeURIComponent(cursor)}&limit=${encodeURIComponent(limit)}`;
    let res;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: this.getHeaders()
      });
    } catch (netErr) {
      throw netErr;
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new SyncError(
        data.error?.message || `Pull changes failed with HTTP ${res.status}`,
        data.error?.code || 'PULL_FAILED',
        res.status,
        data.error
      );
    }

    return data;
  }

  async getBootstrap() {
    const response = await this.fetchWithTimeout(
      `${this.baseUrl}/api/sync/bootstrap`,
      { method: 'GET', headers: this.getHeaders() },
      60000
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new SyncError(
        data.error?.message || `Bootstrap failed with HTTP ${response.status}`,
        data.error?.code || 'BOOTSTRAP_FAILED',
        response.status,
        data.error
      );
    }
    if (data.success !== true) {
      throw new SyncError(
        data.error?.message || 'Bootstrap response was rejected',
        data.error?.code || 'BOOTSTRAP_FAILED',
        response.status || 502,
        data.error
      );
    }
    return data;
  }

  async getPeriodArchive(periodId) {
    const normalizedId = String(periodId || '').trim();
    if (!normalizedId || normalizedId.length > 128) {
      throw new SyncError('Period identifier is invalid', 'INVALID_PERIOD_ID', 400);
    }
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/periods/${encodeURIComponent(normalizedId)}/archive`, {
      method: 'GET',
      headers: this.getHeaders()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SyncError(data.error?.message || `Period archive read failed with HTTP ${res.status}`,
        data.error?.code || 'PERIOD_ARCHIVE_READ_FAILED', res.status, data.error);
    }
    return data.archive;
  }

  async acquirePartyLease(blockSize = 50) {
    const url = `${this.baseUrl}/api/leases/party`;
    let res;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ blockSize })
      });
    } catch (netErr) {
      throw netErr;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SyncError(
        data.error?.message || `Lease acquisition failed with HTTP ${res.status}`,
        data.error?.code || 'LEASE_FAILED',
        res.status,
        data.error
      );
    }

    return data;
  }

  async revokePartyLease(leaseId) {
    const url = `${this.baseUrl}/api/leases/party/revoke`;
    let res;
    try {
      res = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ leaseId })
      });
    } catch (netErr) {
      throw netErr;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new SyncError(
        data.error?.message || `Lease revocation failed with HTTP ${res.status}`,
        data.error?.code || 'REVOKE_FAILED',
        res.status,
        data.error
      );
    }

    return data;
  }
}

module.exports = {
  SyncClient,
  SyncError,
  SyncNetworkError
};
