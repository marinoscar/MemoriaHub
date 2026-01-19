import ffmpeg, { FfprobeData } from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { workerConfig } from '../config/index.js';
import { logger, LogEventTypes } from '../infrastructure/logging/index.js';

/**
 * Result from video frame extraction
 */
export interface FrameExtractionResult {
  framePath: string;
  timestamp: number;
  durationSeconds: number | null;
}

/**
 * Video processor using FFmpeg
 * Handles frame extraction for video thumbnails
 */
export class VideoProcessor {
  /**
   * Extract a frame from a video file
   * @param inputPath Path to video file
   * @param outputDir Optional directory for output (uses temp dir if not specified)
   * @returns Path to extracted frame
   */
  async extractFrame(
    inputPath: string,
    outputDir?: string
  ): Promise<FrameExtractionResult> {
    const startTime = Date.now();

    try {
      logger.debug({
        eventType: LogEventTypes.PROCESSOR_STARTED,
        processor: 'video',
        operation: 'extractFrame',
        inputPath,
      }, 'Starting video frame extraction');

      // Get video duration first
      const durationSeconds = await this.getDuration(inputPath);

      // Calculate timestamp: min(1 second, 10% of duration)
      let timestamp = 1;
      if (durationSeconds !== null && durationSeconds > 0) {
        timestamp = Math.min(1, durationSeconds * 0.1);
      }

      // Generate output path
      const dir = outputDir || await this.getTempDir();
      const outputPath = path.join(dir, `frame-${Date.now()}.jpg`);

      // Extract frame
      await this.extractFrameAtTimestamp(inputPath, outputPath, timestamp);

      // Verify the frame was created
      const stats = await fs.stat(outputPath);
      if (stats.size === 0) {
        throw new Error('Extracted frame is empty');
      }

      logger.debug({
        eventType: LogEventTypes.PROCESSOR_COMPLETED,
        processor: 'video',
        operation: 'extractFrame',
        inputPath,
        outputPath,
        timestamp,
        durationSeconds,
        frameSize: stats.size,
        durationMs: Date.now() - startTime,
      }, 'Video frame extracted');

      return {
        framePath: outputPath,
        timestamp,
        durationSeconds,
      };
    } catch (error) {
      // If extraction at calculated timestamp fails, try first frame
      logger.warn({
        eventType: 'video.frame_extraction_fallback',
        inputPath,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Frame extraction failed, trying first frame');

      try {
        const dir = outputDir || await this.getTempDir();
        const outputPath = path.join(dir, `frame-${Date.now()}.jpg`);
        await this.extractFrameAtTimestamp(inputPath, outputPath, 0);

        const stats = await fs.stat(outputPath);

        logger.debug({
          eventType: LogEventTypes.PROCESSOR_COMPLETED,
          processor: 'video',
          operation: 'extractFrame',
          inputPath,
          outputPath,
          timestamp: 0,
          frameSize: stats.size,
          durationMs: Date.now() - startTime,
          fallback: true,
        }, 'Video frame extracted (fallback to first frame)');

        return {
          framePath: outputPath,
          timestamp: 0,
          durationSeconds: null,
        };
      } catch (fallbackError) {
        logger.error({
          eventType: LogEventTypes.PROCESSOR_ERROR,
          processor: 'video',
          operation: 'extractFrame',
          inputPath,
          error: fallbackError instanceof Error ? fallbackError.message : 'Unknown error',
          durationMs: Date.now() - startTime,
        }, 'Video frame extraction failed');
        throw fallbackError;
      }
    }
  }

  /**
   * Get video duration in seconds
   */
  async getDuration(inputPath: string): Promise<number | null> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(inputPath, (err: Error | null, metadata: FfprobeData) => {
        if (err) {
          logger.warn({
            eventType: 'video.probe_error',
            inputPath,
            error: err.message,
          }, 'Failed to probe video duration');
          resolve(null);
          return;
        }

        const duration = metadata.format?.duration;
        resolve(typeof duration === 'number' ? duration : null);
      });
    });
  }

  /**
   * Check if FFmpeg is available
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      ffmpeg.getAvailableFormats((err: Error | null) => {
        if (err) {
          logger.warn({
            eventType: 'video.ffmpeg_unavailable',
            error: err.message,
          }, 'FFmpeg is not available');
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  /**
   * Extract frame at specific timestamp
   */
  private extractFrameAtTimestamp(
    inputPath: string,
    outputPath: string,
    timestamp: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .seekInput(timestamp)
        .frames(1)
        .outputOptions([
          '-vf', 'select=eq(n\\,0)', // Select first frame after seek
          '-q:v', '2', // High quality JPEG
        ])
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
  }

  /**
   * Get or create temp directory
   */
  private async getTempDir(): Promise<string> {
    const tempDir = workerConfig.tempFiles.directory;

    try {
      await fs.access(tempDir);
    } catch {
      await fs.mkdir(tempDir, { recursive: true });
    }

    return tempDir;
  }

  /**
   * Clean up a temporary frame file
   */
  async cleanupFrame(framePath: string): Promise<void> {
    try {
      await fs.unlink(framePath);
      logger.debug({
        eventType: 'video.frame_cleanup',
        framePath,
      }, 'Frame file cleaned up');
    } catch (error) {
      logger.warn({
        eventType: 'video.frame_cleanup_error',
        framePath,
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Failed to clean up frame file');
    }
  }
}

// Export singleton instance
export const videoProcessor = new VideoProcessor();
