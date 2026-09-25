import { describe, expect, it } from 'vitest';
import {
  planMultipart,
  computePartPlan,
  InvalidUploadSizeError,
  MAX_PARTS,
  MIN_PART_SIZE_BYTES,
  MAX_UPLOAD_BYTES,
  DEFAULT_PART_SIZE_BYTES,
} from '../multipart-plan';

describe('planMultipart (public entry point, enforces the deployment size ceiling)', () => {
  it('uses the default part size for a small file', () => {
    const { partSize, totalParts } = planMultipart(100 * 1024 * 1024); // 100 MiB
    expect(partSize).toBe(DEFAULT_PART_SIZE_BYTES);
    expect(totalParts).toBe(2);
  });

  it('rejects zero, negative, NaN and non-finite sizes', () => {
    expect(() => planMultipart(0)).toThrow(InvalidUploadSizeError);
    expect(() => planMultipart(-1)).toThrow(InvalidUploadSizeError);
    expect(() => planMultipart(Number.NaN)).toThrow(InvalidUploadSizeError);
    expect(() => planMultipart(Number.POSITIVE_INFINITY)).toThrow(InvalidUploadSizeError);
  });

  it('rejects sizes above the configured ceiling', () => {
    expect(() => planMultipart(MAX_UPLOAD_BYTES + 1)).toThrow(InvalidUploadSizeError);
  });

  it('accepts a size exactly at the ceiling and stays within R2/S3 part limits', () => {
    const { partSize, totalParts } = planMultipart(MAX_UPLOAD_BYTES);
    expect(totalParts).toBeLessThanOrEqual(MAX_PARTS);
    expect(partSize * totalParts).toBeGreaterThanOrEqual(MAX_UPLOAD_BYTES);
  });

  it('covers the whole file for a range of representative video sizes (500MB to 100GB)', () => {
    for (const gb of [0.5, 1, 5, 10, 20, 50, 100]) {
      const size = gb * 1024 * 1024 * 1024;
      const { partSize, totalParts } = planMultipart(size);
      expect(partSize * totalParts).toBeGreaterThanOrEqual(size);
      expect(totalParts).toBeLessThanOrEqual(MAX_PARTS);
    }
  });
});

describe('computePartPlan (pure math, no ceiling — exercises the >MAX_PARTS scaling branch directly)', () => {
  it('rejects non-positive sizes', () => {
    expect(() => computePartPlan(0)).toThrow(InvalidUploadSizeError);
    expect(() => computePartPlan(-5)).toThrow(InvalidUploadSizeError);
  });

  it('never produces a part size below the R2/S3 minimum', () => {
    const { partSize } = computePartPlan(1); // 1 byte
    expect(partSize).toBeGreaterThanOrEqual(MIN_PART_SIZE_BYTES);
  });

  it('scales the part size up, never exceeding MAX_PARTS, for a file the default part size cannot cover', () => {
    // Deliberately far beyond this deployment's MAX_UPLOAD_BYTES ceiling — this function has no
    // ceiling of its own, and this is the only way to exercise the >10,000-parts branch at all,
    // since 100 GiB / 64 MiB never gets close to that limit. See the module's doc comment.
    const hugeSize = DEFAULT_PART_SIZE_BYTES * (MAX_PARTS + 500);
    const { partSize, totalParts } = computePartPlan(hugeSize);
    expect(totalParts).toBeLessThanOrEqual(MAX_PARTS);
    expect(partSize).toBeGreaterThan(DEFAULT_PART_SIZE_BYTES);
    expect(partSize % MIN_PART_SIZE_BYTES).toBe(0);
    expect(partSize * totalParts).toBeGreaterThanOrEqual(hugeSize);
  });
});
