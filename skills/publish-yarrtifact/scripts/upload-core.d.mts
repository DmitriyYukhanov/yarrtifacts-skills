/** Types for upload-core.mjs — kept next to the implementation so the product repo's
 *  strict-TS tests can import the exact file the public skill ships. */

export class UploadError extends Error {
  status?: number;
  /** Set when a create-path failure left a 'processing' draft behind — pass it back as `abandon` on retry. */
  artifactId?: string;
  /** Set by editArtifact when the slug call fails after the title already committed. */
  partial?: { title?: string | null };
  constructor(message: string, status?: number);
}

/** Exactly one of `body` (inline) or `readBody` (lazy per-file read) must be provided. */
export type UploadFile = { relativePath: string; size: number } & (
  | { body: string | Uint8Array; readBody?: never }
  | { body?: never; readBody: () => string | Uint8Array }
);

export interface UploadResult {
  url: string;
  slug: string;
  artifactId: string;
  versionId: string;
  /** false = the version stored but the artifact is unpublished, so the link is dormant. */
  published: boolean;
}

export interface EditResult {
  artifactId: string;
  /** null when the title was explicitly cleared (sanitizeTitle('') on the server). */
  title?: string | null;
  slug?: string;
  /** Set only when the slug changed. */
  url?: string;
  /** Set only when the slug changed. false = the new link is dormant (the artifact isn't live). */
  published?: boolean;
}

export function formatFailure(status: number, body: { message?: string; error?: string } | null | undefined): string;
export function validateArgs(args: { replace?: string; title?: string; slug?: string; abandon?: string; edit?: string; dir?: string }): void;
export function encodePath(rel: string): string;
export function bodyByteLength(body: string | Uint8Array): number;
export function uploadFiles(
  opts: { apiOrigin: string; token: string; files: UploadFile[]; title?: string; slug?: string; replace?: string; abandon?: string },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<UploadResult>;
export function editArtifact(
  opts: { apiOrigin: string; token: string; artifactId: string; title?: string; slug?: string },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<EditResult>;
