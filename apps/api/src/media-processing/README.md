# Storage Processing Pipeline

This directory contains the async post-upload processing infrastructure and all registered processors.

## Adding a New Processor

Implement `ObjectProcessor` (see `object-processor.interface.ts`), register it in `object-processing.module.ts`, and set a unique priority.

## Image Orientation — Mandatory Convention

**Any processor or handler that reads image pixels MUST use `prepareImageForProcessing` from `image-orientation.util.ts` instead of decoding raw bytes directly.**

```typescript
import { prepareImageForProcessing } from './image-orientation.util';

const { buffer, width, height } = await prepareImageForProcessing(rawBuffer, { maxDim: 1920 });
// `buffer` is an upright JPEG with EXIF rotation already applied.
// `width` / `height` are display (orientation-corrected) dimensions.
```

`prepareImageForProcessing` applies sharp's `.rotate()` (which reads the EXIF orientation tag), optionally downscales, and never throws — on any error it falls back to the original buffer with zero dims so the pipeline continues.

Original uploaded files are never altered; only the derivative/processing path is normalized.
