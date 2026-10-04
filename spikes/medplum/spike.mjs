import { readFileSync } from 'node:fs';
import { indexStructureDefinitionBundle, validateResource } from '@medplum/core';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dir = new URL('../../node_modules/@medplum/definitions/dist/fhir/r4/', import.meta.url).pathname;
const t0 = performance.now();
for (const f of ['profiles-types.json','profiles-resources.json']) {
  indexStructureDefinitionBundle(JSON.parse(readFileSync(dir+f,'utf8')));
}
console.log('load ms', Math.round(performance.now()-t0), 'rssMB', Math.round(process.memoryUsage().rss/1e6));

const obs = (code, display, value, unit, ucum) => ({
  resourceType:'Observation', status:'final',
  category:[{coding:[{system:'http://terminology.hl7.org/CodeSystem/observation-category',code:'exam'}]}],
  code:{coding:[{system:'http://loinc.org',code,display}]},
  subject:{reference:'Patient/P-7F3A'}, effectiveDateTime:'2026-10-03T10:00:00Z',
  valueQuantity:{value, unit, system:'http://unitsofmeasure.org', code:ucum},
});
const issue = { resourceType:'DetectedIssue', status:'preliminary', severity:'moderate',
  code:{text:'Values deviate from the plan'}, patient:{reference:'Patient/P-7F3A'},
  identifiedDateTime:'2026-10-03T10:00:00Z', detail:'Flexion below weekly target by more than tolerance.' };

const pos = {
  flexion: obs('41379-9','Knee flexion AROM',95,'degrees','deg'),
  extension: obs('41377-3','Knee extension AROM',2,'degrees','deg'),
  pain: obs('72514-3','Pain severity 0-10',3,'score','{score}'),
  issue,
};
const neg = {
  noStatus: (()=>{const o=obs('41379-9','x',1,'d','deg'); delete o.status; return o;})(),
  stringValue: (()=>{const o=obs('41379-9','x',1,'d','deg'); o.valueQuantity.value='95'; return o;})(),
  unknownProp: {...obs('41379-9','x',1,'d','deg'), bogus:1},
  badDate: {...obs('41379-9','x',1,'d','deg'), effectiveDateTime:'yesterday'},
  issueNoStatus: (()=>{const i={...issue}; delete i.status; return i;})(),
};
let ok = true;
for (const [k,r] of Object.entries(pos)) { try { validateResource(r); console.log('PASS ok  ',k);} catch(e){ ok=false; console.log('FAIL pos ',k,e.message?.slice(0,150)); } }
for (const [k,r] of Object.entries(neg)) { try { validateResource(r); ok=false; console.log('FAIL neg (accepted)',k);} catch(e){ console.log('PASS rej ',k,'-',(e.outcome?.issue?.[0]?.details?.text ?? e.message).slice(0,80)); } }
console.log(ok?'SPIKE OK':'SPIKE FAILED');
