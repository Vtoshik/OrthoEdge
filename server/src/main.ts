import { readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { seed } from './seed';
import { Store } from './store';

const root = fileURLToPath(new URL('../../', import.meta.url));
const store = new Store(process.env.DATA_DIR ?? `${root}data/runtime`);
const certDir = `${root}data/certs`;
const https = !process.env.HTTP && existsSync(`${certDir}/key.pem`) ? { key: readFileSync(`${certDir}/key.pem`), cert: readFileSync(`${certDir}/cert.pem`) } : undefined;
const allowAnyDate = !!process.env.DEMO_ALLOW_ANY_DATE;
const { app, ingest } = await buildApp({ store, https, allowAnyDate, pin: process.env.PORTAL_PIN, publicDirs: { patient: `${root}apps/patient/dist`, portal: `${root}apps/portal/dist` } });

if (!Object.keys(store.protocols).length || process.argv.includes('--reseed')) { store.reset(); await seed(store, ingest); console.log('seeded 3 synthetic patients'); }
const port = Number(process.env.PORT ?? 8443);
await app.listen({ port, host: '0.0.0.0' });
const ips = Object.entries(networkInterfaces()).flatMap(([n, l]) => (l ?? []).filter((i) => i.family === 'IPv4' && !i.internal && !n.startsWith('docker')).map((i) => `${i.address} (${n})`));
const proto = https ? 'https' : 'http';
console.log(`\nTry from the phone (use the address on the SAME network as the phone, usually wlan/wlp):`);
for (const a of ips) console.log(`  ${proto}://${a.split(' ')[0]}:${port}/   [${a.split(' ')[1].slice(1, -1)}]`);
console.log(`Doctor portal: same address + /portal/   (PIN ${process.env.PORTAL_PIN ?? '1234'} — demo only)`);
if (allowAnyDate) console.log('DEMO MODE: measurement-date window disabled so the "+1 day" tool works. Do not use outside a demo.');
if (!https) console.log('WARNING: no TLS (data/certs missing): phone sensors and Web Crypto need HTTPS. Run scripts/make-cert.sh');
