-- Add faceRecognitionEnabled flag to circles table.
-- Default FALSE — biometric data must be explicitly opted in per circle.
ALTER TABLE "circles"
  ADD COLUMN "face_recognition_enabled" BOOLEAN NOT NULL DEFAULT FALSE;
