/**
 * Unit tests for the enrichment job-type → friendly-label map (`JOB_TYPE_LABELS`)
 * and its `jobTypeLabel()` lookup helper.
 *
 * Covers the four Media Workflow Automation job types added in issue #143
 * (`workflow_evaluate`, `workflow_evaluate_item`, `workflow_execute_batch`,
 * `workflow_history_purge`), a sampling of pre-existing types to guard against
 * regression, and the title-case fallback for an unknown/future type.
 */

import { JOB_TYPE_LABELS, jobTypeLabel } from './job-type-labels';

describe('job-type-labels', () => {
  describe('workflow job types (issue #143)', () => {
    it('labels workflow_evaluate', () => {
      expect(jobTypeLabel('workflow_evaluate')).toBe('Workflow evaluate');
    });

    it('labels workflow_evaluate_item', () => {
      expect(jobTypeLabel('workflow_evaluate_item')).toBe('Workflow evaluate (item)');
    });

    it('labels workflow_execute_batch', () => {
      expect(jobTypeLabel('workflow_execute_batch')).toBe('Workflow execute batch');
    });

    it('labels workflow_history_purge', () => {
      expect(jobTypeLabel('workflow_history_purge')).toBe('Workflow history purge');
    });

    it('includes all four workflow types in the JOB_TYPE_LABELS map directly', () => {
      expect(JOB_TYPE_LABELS['workflow_evaluate']).toBe('Workflow evaluate');
      expect(JOB_TYPE_LABELS['workflow_evaluate_item']).toBe('Workflow evaluate (item)');
      expect(JOB_TYPE_LABELS['workflow_execute_batch']).toBe('Workflow execute batch');
      expect(JOB_TYPE_LABELS['workflow_history_purge']).toBe('Workflow history purge');
    });
  });

  describe('trash-empty job types (issue #165)', () => {
    it('labels trash_empty_evaluate', () => {
      expect(jobTypeLabel('trash_empty_evaluate')).toBe('Empty trash evaluate');
    });

    it('labels trash_empty_execute_batch', () => {
      expect(jobTypeLabel('trash_empty_execute_batch')).toBe('Empty trash execute batch');
    });

    it('includes both trash-empty types in the JOB_TYPE_LABELS map directly', () => {
      expect(JOB_TYPE_LABELS['trash_empty_evaluate']).toBe('Empty trash evaluate');
      expect(JOB_TYPE_LABELS['trash_empty_execute_batch']).toBe('Empty trash execute batch');
    });
  });

  describe('location-suggestion bulk accept/reject run job types', () => {
    it('labels location_suggestion_run_evaluate', () => {
      expect(jobTypeLabel('location_suggestion_run_evaluate')).toBe(
        'Location suggestion run evaluate',
      );
    });

    it('labels location_suggestion_run_execute_batch', () => {
      expect(jobTypeLabel('location_suggestion_run_execute_batch')).toBe(
        'Location suggestion run execute batch',
      );
    });

    it('includes both types in the JOB_TYPE_LABELS map directly', () => {
      expect(JOB_TYPE_LABELS['location_suggestion_run_evaluate']).toBe(
        'Location suggestion run evaluate',
      );
      expect(JOB_TYPE_LABELS['location_suggestion_run_execute_batch']).toBe(
        'Location suggestion run execute batch',
      );
    });
  });

  describe('pre-existing job types (regression guard)', () => {
    it.each([
      ['face_detection', 'Face detection'],
      ['video_face_detection', 'Video face detection'],
      ['auto_tagging', 'Auto-tagging'],
      ['geocode', 'Geocoding'],
      ['storage_insights', 'Storage insights'],
      ['trash_purge', 'Trash purge'],
      ['job_history_purge', 'Job history purge'],
    ])('labels %s as %s', (type, label) => {
      expect(jobTypeLabel(type)).toBe(label);
    });
  });

  describe('unknown type fallback', () => {
    it('title-cases a snake_case type not present in the map', () => {
      expect(jobTypeLabel('some_future_job_type')).toBe('Some Future Job Type');
    });

    it('handles a single-word unknown type', () => {
      expect(jobTypeLabel('foo')).toBe('Foo');
    });

    it('does not throw or return an empty string for an empty type', () => {
      expect(jobTypeLabel('')).toBe('');
    });
  });
});
