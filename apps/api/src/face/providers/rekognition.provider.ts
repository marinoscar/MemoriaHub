// =============================================================================
// AWS Rekognition Provider
// =============================================================================
//
// Uses AWS Rekognition for face detection and delegated recognition
// (via Rekognition Collections). AWS credentials are resolved from the
// environment (env vars, instance role, etc.) by the AWS SDK automatically —
// `apiKey` in the stored credential is unused for this provider.
//
// Bounding box note: AWS returns fractions (0–1 of image dimensions) for
// Left, Top, Width, Height. These are stored as-is (normalized coordinates)
// rather than converting to absolute pixels, since Rekognition callers do not
// supply image dimensions at this API layer.
// =============================================================================

import {
  RekognitionClient,
  DetectFacesCommand,
  IndexFacesCommand,
  SearchFacesByImageCommand,
  ListCollectionsCommand,
} from '@aws-sdk/client-rekognition';
import type {
  FaceProvider,
  FaceCapabilities,
  FaceProviderCredentials,
  DetectedFace,
} from './face-provider.interface';

export class RekognitionProvider implements FaceProvider {
  readonly key = 'rekognition';

  readonly capabilities: FaceCapabilities = {
    detect: true,
    embed: false,
    delegatedRecognize: true,
  };

  readonly modelVersion = 'rekognition-2023';

  // -------------------------------------------------------------------------
  // detect
  // -------------------------------------------------------------------------

  async detect(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<DetectedFace[]> {
    const client = this.buildClient(creds);
    const command = new DetectFacesCommand({
      Image: { Bytes: image },
      Attributes: ['DEFAULT'],
    });

    const response = await client.send(command);
    const faceDetails = response.FaceDetails ?? [];

    return faceDetails.map(detail => {
      const box = detail.BoundingBox;
      const face: DetectedFace = {
        // AWS BoundingBox uses Left/Top/Width/Height as normalized fractions (0–1)
        boundingBox: {
          x: box?.Left ?? 0,
          y: box?.Top ?? 0,
          w: box?.Width ?? 0,
          h: box?.Height ?? 0,
        },
        confidence: detail.Confidence !== undefined ? detail.Confidence / 100 : undefined,
      };
      return face;
    });
  }

  // -------------------------------------------------------------------------
  // enroll — IndexFaces into a Rekognition collection
  // -------------------------------------------------------------------------

  async enroll(
    creds: FaceProviderCredentials,
    image: Buffer,
    externalImageId: string,
  ): Promise<string> {
    const client = this.buildClient(creds);
    const command = new IndexFacesCommand({
      CollectionId: externalImageId,
      Image: { Bytes: image },
      ExternalImageId: externalImageId,
      DetectionAttributes: ['DEFAULT'],
    });

    const response = await client.send(command);
    const first = response.FaceRecords?.[0];
    if (!first?.Face?.FaceId) {
      throw new Error('Rekognition IndexFaces returned no FaceId');
    }
    return first.Face.FaceId;
  }

  // -------------------------------------------------------------------------
  // recognize — SearchFacesByImage
  // -------------------------------------------------------------------------

  async recognize(
    creds: FaceProviderCredentials,
    image: Buffer,
  ): Promise<{ externalFaceId: string; similarity: number }[]> {
    // Rekognition SearchFacesByImage requires a CollectionId; we use a sentinel
    // collection key. Phase 2 will pass per-circle collection IDs directly.
    const client = this.buildClient(creds);
    const command = new SearchFacesByImageCommand({
      CollectionId: 'default',
      Image: { Bytes: image },
      MaxFaces: 10,
      FaceMatchThreshold: 70,
    });

    const response = await client.send(command);
    const matches = response.FaceMatches ?? [];

    return matches
      .filter(m => m.Face?.FaceId !== undefined)
      .map(m => ({
        externalFaceId: m.Face!.FaceId!,
        // AWS returns Similarity as 0–100; normalize to 0–1
        similarity: (m.Similarity ?? 0) / 100,
      }));
  }

  // -------------------------------------------------------------------------
  // listModels — static list for Rekognition
  // -------------------------------------------------------------------------

  async listModels(_creds: FaceProviderCredentials): Promise<string[]> {
    return [this.modelVersion];
  }

  // -------------------------------------------------------------------------
  // testConnection — ListCollections (cheap, read-only)
  // -------------------------------------------------------------------------

  async testConnection(
    creds: FaceProviderCredentials,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = this.buildClient(creds);
      const command = new ListCollectionsCommand({ MaxResults: 1 });
      await client.send(command);
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a RekognitionClient using the stored region.
   * AWS credentials are picked up automatically from env vars, instance role,
   * or the default credential chain — `apiKey` is unused for Rekognition.
   */
  private buildClient(creds: FaceProviderCredentials): RekognitionClient {
    return new RekognitionClient({
      region: creds.region ?? 'us-east-1',
    });
  }
}
