import crypto from 'node:crypto';
import type { WorkflowDocument } from '@ignite/api';
import {
  WorkflowNamePattern,
  makeWorkflowDocumentSchema,
  validateWorkflowClosure,
} from '@ignite/api';
import type { RepoService } from '../repos/RepoService.js';

const MAX_WORKFLOW_BYTES = 512 * 1024;

export class WorkflowHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function hashWorkflowRaw(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function workflowRelPath(name: string): string {
  return `ignite/workflows/${name}.json`;
}

export function validateWorkflowName(name: string): void {
  if (!WorkflowNamePattern.test(name)) {
    throw new WorkflowHttpError(400, 'WORKFLOW_NAME_INVALID', 'Workflow name is invalid');
  }
}

export function parseWorkflowDocument(
  raw: string,
  allowFileUrls: boolean,
): WorkflowDocument {
  if (Buffer.byteLength(raw) > MAX_WORKFLOW_BYTES) {
    throw new WorkflowHttpError(422, 'WORKFLOW_TOO_LARGE', 'Workflow exceeds 512 KiB');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new WorkflowHttpError(
      422,
      'WORKFLOW_JSON_INVALID',
      error instanceof Error ? error.message : String(error),
    );
  }
  const parsed = makeWorkflowDocumentSchema({ allowFileUrls }).safeParse(value);
  if (!parsed.success) {
    throw new WorkflowHttpError(422, 'WORKFLOW_INVALID', parsed.error.message);
  }
  const document = parsed.data;
  const missing = validateWorkflowClosure(document);
  if (missing.length > 0) {
    throw new WorkflowHttpError(
      422,
      'WORKFLOW_CLOSURE_INVALID',
      `Missing required plugin ids: ${missing.join(', ')}`,
    );
  }
  return document;
}

export async function readWorkflowDocument(
  repos: Pick<RepoService, 'getFile'>,
  pathOrUrl: string,
  name: string,
  allowFileUrls: boolean,
): Promise<{ document: WorkflowDocument; raw: string; docHash: string }> {
  validateWorkflowName(name);
  const result = await repos.getFile(pathOrUrl, workflowRelPath(name));
  if (!result.success) {
    throw new WorkflowHttpError(
      result.error.code === 'FILE_NOT_FOUND' ? 404 : 400,
      result.error.code,
      result.error.message,
    );
  }
  const raw = result.data.content;
  return {
    document: parseWorkflowDocument(raw, allowFileUrls),
    raw,
    docHash: hashWorkflowRaw(raw),
  };
}
