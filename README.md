# OrthoEdge: edge-native tele-rehabilitation demo (hackathon MVP)

A phone turns into a home knee-angle meter. The angle and the rules run **on the phone**; only a **signed daily summary or alert** (FHIR) reaches the clinic, where a doctor portal shows only the patients who deviate from the plan.

**Not a medical device.** Synthetic data only. Accuracy of our own implementation has not been measured yet (see "Known limits").

## What is live and what is simulated

| Part | Status |
| --- | --- |
| Angle from the phone's motion sensor, guided 4-reading session, plausibility checks | Live (laptop browsers use a simulated sensor through the same code) |
| Rule engine (weekly pace, tolerance, trend, pain limit, stage criteria) | Live, deterministic, no AI at runtime, runs on the phone |
| FHIR `Observation` and `DetectedIssue`, validated with **Medplum** | Live |
| Signing (ES256, key the page cannot read back), replay and tamper rejection, audit log | Live |
| Clinic side (server, doctor portal, protocol editor, "advance stage") | Live, but the laptop stands in for a clinic |
| e-referral, national e-health systems, reminders, calibration | Not built (the protocol screen is a labelled mock) |

## Requirements
Node.js 22+ and npm 10+. For the browser test: Chrome or Chromium (or set `CHROME_PATH`). For a real phone: the phone and laptop on the same network.

## 1. Fastest check (about 2 minutes, no phone)
```bash
npm install
npm run check        # 63 unit/integration tests, then the full flow in a real browser
```
`npm run check` = `npm test` + `npm run e2e`. The end-to-end run builds both apps, starts its own isolated server (port 9443, throw-away data), drives the real patient app and portal in headless Chrome, and prints `END-TO-END: all checks passed`. It covers: enrolment, a rejected "phone left in one place" bend, a normal day, a red-flag day with an alert, a **tampered** message (rejected), a **replayed** message (rejected), measuring **offline** and delivery after reconnecting, and the clinician confirming checks and **advancing a stage** in the portal.

## 2. Click through it yourself
```bash
npm install
npm run demo         # builds, loads 3 synthetic patients, starts the server (prints the addresses)
```
On a laptop nothing else is needed: without a certificate the server uses plain `http://localhost:8443`, which browsers still treat as a secure context, so the app and the signing key work (the sensor is simulated). A **phone** needs HTTPS, so run `npm run cert` first (see section 3) and use the `https://` addresses instead.

1. Open the **doctor portal**: `http://localhost:8443/portal/` (or `https://localhost:8443/portal/` if you ran `npm run cert`; accept the browser's certificate warning). Demo PIN **1234**.
2. The list is sorted by exception: **Ewa** has a red flag, **Marek** may be ready for a stage review, **Jan** is on plan.
3. Open **Jan**, then *Edit protocol … and invite patient* → *Invite patient*. Open the setup link in another tab (or scan the QR with a phone) and press *Set up*.
4. In the patient app press *Start today's session*. On a laptop the sensor is simulated (a slider); the angle code is the real one. Pick lying or sitting, measure bend then straighten, tap a pain level, *Finish Session*. A normal day sends nothing alarming.
5. Back on the home screen open *Demo tools*: choose *red-flag day*, press *+1 day*, measure again. The portal shows the red flag live.
6. *Demo tools* → tick *Tamper* and measure: the portal logs `signature invalid`. *Replay last message* is rejected too. See the **Security log** in the portal.
7. Open **Marek**: the app only *flags* readiness; the clinician ticks the checks the app cannot measure and presses *Advance*.

`npm run demo` resets all data every time, so phones must be set up again with a new link.

## 3. On a real phone
Use the **same Wi-Fi** (a phone hotspot works; nothing needs the internet). Run `npm run cert` after joining the network (it creates a local certificate for the laptop's current address; install `mkcert` first to avoid the browser warning), then `npm run demo`; the server prints the addresses. Open the portal at the **IP address** (`https://<IP>:8443/portal/`, not `localhost`) so the setup QR works on the phone. Accept the certificate warning on the phone, scan the QR, press *Set up*, turn **off** *Demo tools → Simulate sensor*, and measure. Motion sensors and the signing key need HTTPS.

## What to look at (security and privacy by design)
| Mechanism | Where | Covered by |
| --- | --- | --- |
| Raw sensor data never leaves the phone; only a daily summary and alerts are sent | `apps/patient/src/App.tsx`, `outbox.ts` | e2e ("show exactly what was sent") |
| Device key created **non-extractable**, public key registered once with a one-time token | `keystore.ts`, `/api/enroll` | `server/test/app.test.ts` |
| Every export signed (ES256) with sequence number, time and unique id; tamper and replay rejected | `packages/engine/src/jws.ts`, `replay.ts` | `jws.test.ts`, `app.test.ts`, e2e |
| Care plan signed by the clinic; the phone refuses another patient's or an older plan | `protocolGuard.ts` | `guards.test.ts` |
| Server re-runs the same rules and flags a client that hides an alert | `server/src/app.ts` | `app.test.ts` |
| FHIR validated with Medplum before anything is stored | `packages/engine/src/validate.ts` | `fhir.test.ts` |
| Names kept apart from measurements and encrypted at rest; files owner-only; hash-chained audit log | `server/src/store.ts`, `crypto.ts` | `store.test.ts`, `app.test.ts` |
| Date window against back-dating (switched off only in `npm run demo` for the "+1 day" tool) | `server/src/app.ts` | `app.test.ts` |
| Strict CSP, no inline scripts, fonts self-hosted, no external requests | `server/src/app.ts` | `app.test.ts` |

## The data is based on published numbers
The three synthetic patients are generated (seeded, repeatable) from published ACL-reconstruction data, not hand-typed: mean flexion at 2/4/6/12 weeks (70 / 92 / 113 / 131 degrees, standard rehab arm), the real patient-to-patient spread (the trial reports standard errors, so the spread is about 24 degrees at 2 weeks), extension loss and pain curves, and the phone's measurement noise (about 3.1 / 2.3 degrees per reading). Sources and assumptions are listed at the top of `server/src/synthetic.ts`, and tests check that the generator reproduces the published means and spread.

## Tests
`npm test` (63 tests): angle maths and plausibility checks (both phone orientations, noise, lying-flat refusal), every rule branch, FHIR build and Medplum validation (valid and broken resources), signing and replay, the whole server pipeline, data at rest, stage advance, and the literature-based generator. `npm run e2e` runs the real UI. `npm run check` runs both.

## Known limits (stated honestly)
- **Accuracy is unmeasured.** Published studies of similar phone methods report errors of about 2 to 4.5 degrees; ours has not been compared with a goniometer yet. Alert tolerances start at 8.5 degrees (flexion) and 6.5 degrees (extension) from the literature.
- A signature proves which device sent a value, not that the measurement is true; phone placement on the leg cannot be verified (the app only refuses obvious mistakes).
- Weekly targets and stage criteria are labelled examples (Calgary-style); the clinician sets them in real use. Real patients vary a lot, so a fixed target flags many of them.
- The trust model is a demo (no real PKI, shared demo PIN, self-signed certificate). GDPR basis, consent and medical-device classification are future work.
- Tested on Node 22 and Chrome. The page itself cannot be opened offline; measuring and queueing work once it is loaded.

## Project layout
```
packages/engine   shared TypeScript: angle, rules, FHIR, signing, replay guard (+ tests)
server            Fastify: enrol, protocol, ingest pipeline, portal API, audit log, synthetic patients (+ tests)
apps/patient      phone web app (Preact)           apps/portal   doctor portal (Preact)
config            sample protocol (all clinical thresholds live here, never in code)
scripts           make-cert.sh, e2e.mjs, gen-illustrations.mjs (draws the 8 position pictures)
spikes/medplum    the library test the brief asked for (Medplum validates valid resources, rejects broken ones)
```

## Troubleshooting
- *Port 8443 in use*: stop the old server, or `PORT=9443 npm run demo`.
- *Phone cannot open the page*: same network? Use the IP the server prints, `https://`, and allow port 8443 in the laptop firewall. Phone hotspots sometimes block devices from reaching each other; make the laptop the hotspot instead.
- *"Not delivered" on the phone*: the screen says why. Most often the demo data was reset (set the phone up again) or the phone's clock/date is wrong.
- *No Chrome for the e2e test*: install Chrome/Chromium or set `CHROME_PATH=/path/to/chrome`.

## Third-party software and AI use
Libraries (all permissive licences): Medplum core/fhirtypes/definitions (Apache-2.0), jose, Fastify, @fastify/static, Preact, Vite, qrcode, Readex Pro font via @fontsource (OFL-1.1), Vitest, TypeScript, tsx, playwright-core. AI tool used for planning, research support, code, tests and drafts: Claude Code (Anthropic). No AI model runs at runtime; all decisions are deterministic rules. Implementation started after 23:00 on 3 October 2026.
