#!/usr/bin/env node
// Nightly runtime intake gate. See docs/vibe/design/m3-sidecar-binary.md and ADR-0011 decision 7.
//
//   node vibe/tools/sidecar-intake.mjs [--now YYYY-MM-DD] [--root <dir>]
//
// The manifest loader binds every archive URL to the recorded source and tag; this check adds the
// enforced seven-day rule for every pin, so a nightly that has not been public long enough fails here
// and the installer refuses it too. `--now` replays a recorded date; the default is the machine clock.
import path from 'node:path';
import { isMain, parseArgs, report, rootFrom } from './lib.mjs';
import {
  INTAKE_MIN_PUBLIC_DAYS,
  SidecarError,
  assertIntakePolicy,
  loadSidecarManifestFile,
} from '../../src/stable/runtime/sidecar.mjs';

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseNow(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new SidecarError('invalid-options', '--now must be a YYYY-MM-DD date');
  }
  const parsed = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new SidecarError('invalid-options', '--now must be a real calendar date');
  }
  return parsed;
}

export function checkSidecarIntake(root, { now } = {}) {
  const errors = [];
  let manifest;
  try {
    manifest = assertIntakePolicy(
      loadSidecarManifestFile(path.join(root, 'vibe', 'sidecars.json')),
      now === undefined ? {} : { now },
    );
  } catch (error) {
    const code = error instanceof SidecarError ? error.code : 'intake-check-failed';
    const message = error instanceof SidecarError ? error.message : 'the intake check failed';
    errors.push(code + ': ' + message);
    return { errors, manifest };
  }
  for (const sidecar of manifest.sidecars) {
    const eligible = new Date(Date.parse(sidecar.publishedAt + 'T00:00:00Z') + INTAKE_MIN_PUBLIC_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    console.log(`ok      ${sidecar.id} ${sidecar.version} published ${sidecar.publishedAt}, eligible ${eligible}`);
  }
  return { errors, manifest };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  let now;
  let errors;
  try {
    now = parseNow(args.now);
    ({ errors } = checkSidecarIntake(rootFrom(args), { now }));
  } catch (error) {
    const code = error instanceof SidecarError ? error.code : 'intake-check-failed';
    const message = error instanceof SidecarError ? error.message : 'the intake check failed';
    errors = [code + ': ' + message];
  }
  process.exitCode = report('sidecar-intake', errors);
}
