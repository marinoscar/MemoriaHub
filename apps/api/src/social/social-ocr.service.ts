import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as ffmpeg from 'fluent-ffmpeg';
import { streamToBuffer } from '../storage/processing/processors/stream-utils';

export interface OcrOpts {
  durationMs?: number | null;
  frameCount: number;
}

@Injectable()
export class SocialOcrService {
  private readonly logger = new Logger(SocialOcrService.name);

  private readonly langPath: string =
    process.env['TESSERACT_LANG_PATH'] ??
    resolve(__dirname, '../../assets/tessdata');

  async extractOcrText(
    getStream: () => Promise<Readable>,
    opts: OcrOpts,
  ): Promise<string> {
    const tmpFramePaths: string[] = [];
    const tmpVideoPath = join(tmpdir(), `memoriaHub-social-ocr-${randomUUID()}.mp4`);

    try {
      const stream = await getStream();
      const buffer = await streamToBuffer(stream);
      await fs.writeFile(tmpVideoPath, buffer);

      const durationSec = opts.durationMs ? opts.durationMs / 1000 : 0;
      const timestamps = this.computeTimestamps(durationSec, opts.frameCount);

      const texts: string[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let createWorker: ((lang: string, oem?: number, config?: Record<string, unknown>) => Promise<any>) | undefined;
      try {
        const tesseract = await import('tesseract.js');
        createWorker = tesseract.createWorker;
      } catch {
        this.logger.warn('tesseract.js not available; OCR skipped');
        return '';
      }

      for (const seekSec of timestamps) {
        const framePath = join(tmpdir(), `memoriaHub-ocr-frame-${randomUUID()}.jpg`);
        tmpFramePaths.push(framePath);

        try {
          await this.extractFrame(tmpVideoPath, framePath, seekSec);
          const text = await this.runTesseract(createWorker, framePath);
          if (text) texts.push(text);
        } catch (frameErr) {
          const msg = frameErr instanceof Error ? frameErr.message : String(frameErr);
          this.logger.warn(`SocialOcr: frame at ${seekSec}s failed — ${msg}`);
        }
      }

      return texts.join(' ').toLowerCase();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`SocialOcr: extraction failed — ${msg}`);
      return '';
    } finally {
      await fs.unlink(tmpVideoPath).catch(() => {});
      for (const p of tmpFramePaths) {
        await fs.unlink(p).catch(() => {});
      }
    }
  }

  private computeTimestamps(durationSec: number, frameCount: number): number[] {
    if (durationSec <= 0 || frameCount <= 0) return [0];

    const timestamps: number[] = [];

    const lastFrameSec = Math.max(0, durationSec - 0.5);
    timestamps.push(lastFrameSec);

    const remaining = frameCount - 1;
    if (remaining > 0 && durationSec > 1) {
      const interval = durationSec / (remaining + 1);
      for (let i = 1; i <= remaining; i++) {
        const t = interval * i;
        if (Math.abs(t - lastFrameSec) > 0.5) {
          timestamps.push(t);
        }
      }
    }

    return timestamps.sort((a, b) => a - b);
  }

  private extractFrame(videoPath: string, framePath: string, seekSec: number): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekSec)
        .frames(1)
        .output(framePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
  }

  private async runTesseract(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWorker: (lang: string, oem?: number, config?: Record<string, unknown>) => Promise<any>,
    imagePath: string,
  ): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let worker: any;
    try {
      worker = await createWorker('eng', 1, {
        langPath: this.langPath,
        cachePath: this.langPath,
        workerPath: undefined,
        corePath: undefined,
        logger: () => {},
      });
      const { data } = await worker.recognize(imagePath);
      return (data.text ?? '').trim();
    } finally {
      if (worker) {
        await worker.terminate().catch(() => {});
      }
    }
  }
}
