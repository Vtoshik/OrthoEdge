// Node-only (server + tests): @medplum/definitions is ~97 MB, never shipped to the phone.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { indexStructureDefinitionBundle, validateResource } from '@medplum/core';
import type { Resource } from '@medplum/fhirtypes';

let loaded = false;
function load() {
  if (loaded) return;
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve('@medplum/definitions')), '..', 'fhir', 'r4');
  for (const f of ['profiles-types.json', 'profiles-resources.json']) indexStructureDefinitionBundle(JSON.parse(readFileSync(join(dir, f), 'utf8')));
  loaded = true;
}

/** Returns an error message, or undefined when the resource is valid FHIR R4. */
export function validateFhir(r: Resource): string | undefined {
  load();
  try { validateResource(r); return undefined; } catch (e: any) { return e?.outcome?.issue?.[0]?.details?.text ?? String(e?.message ?? e); }
}
export function validateBundle(b: { entry?: { resource?: Resource }[] }): string | undefined {
  for (const e of b.entry ?? []) { const m = e.resource && validateFhir(e.resource); if (m) return m; }
  return b.entry?.length ? undefined : 'empty bundle';
}
