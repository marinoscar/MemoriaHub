// =============================================================================
// Face Provider Interface
// =============================================================================

export const FACE_PROVIDER = 'FACE_PROVIDER';

export interface FaceProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
  region?: string;
}

export interface FaceCapabilities {
  /** Provider can detect faces and return bounding boxes */
  detect: boolean;
  /** Provider can return a numerical embedding vector per face */
  embed: boolean;
  /** Provider handles recognition server-side (e.g. AWS Rekognition collections) */
  delegatedRecognize: boolean;
}

export interface DetectedFace {
  /**
   * Bounding box of the face in the image.
   * CompreFace: absolute pixel coordinates.
   * Rekognition: normalized fractions (0–1 of image dimensions).
   */
  boundingBox: { x: number; y: number; w: number; h: number };
  /** Detection confidence, 0–1 scale */
  confidence?: number;
  /** Raw landmark data from the provider (provider-specific shape) */
  landmarks?: unknown;
  /** L2-normalized embedding vector (for in-app cosine similarity) */
  embedding?: number[];
  /** Provider-assigned face ID (used with delegated recognition flows) */
  externalFaceId?: string;
}

export interface FaceProvider {
  /** Unique string key for this provider (e.g. 'compreface', 'rekognition') */
  readonly key: string;
  readonly capabilities: FaceCapabilities;
  /** Model/algorithm version string, used for staleness detection */
  readonly modelVersion: string;
  /** Whether this provider requires stored encrypted credentials to operate */
  readonly requiresCredentials: boolean;

  /** Detect all faces in an image and return bounding boxes + optional embeddings */
  detect(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<DetectedFace[]>;

  /**
   * Return a single embedding vector for the primary face in an image.
   * Only implemented by providers with capabilities.embed = true.
   */
  embed?(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<number[]>;

  /**
   * Enroll (index) a face image under a given external ID.
   * Only implemented by providers with capabilities.delegatedRecognize = true.
   * Returns the provider-assigned face ID.
   */
  enroll?(
    creds: FaceProviderCredentials,
    image: Buffer,
    externalImageId: string,
  ): Promise<string>;

  /**
   * Recognize a face by comparing against enrolled faces.
   * Only implemented by providers with capabilities.delegatedRecognize = true.
   */
  recognize?(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<{ externalFaceId: string; similarity: number }[]>;

  /** List available model identifiers for this provider */
  listModels(creds: FaceProviderCredentials): Promise<string[]>;

  /** Test that credentials are valid and the service is reachable */
  testConnection(
    creds: FaceProviderCredentials,
  ): Promise<{ ok: boolean; error?: string }>;
}
