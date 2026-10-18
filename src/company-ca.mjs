import fs from 'node:fs';
import path from 'node:path';
import {rootCertificates} from 'node:tls';

export function companyCaEnvironment({
  certsDir = '/certs',
  systemBundle = '/etc/ssl/certs/ca-certificates.crt',
  bundlePath = '/state/company-ca-bundle.pem'
} = {}) {
  let certs;
  try {
    certs = fs.readdirSync(certsDir).filter(name => /\.(crt|pem)$/.test(name) && name !== 'server.crt').sort();
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (!certs.length) return {};

  let publicRoots;
  try {
    publicRoots = fs.readFileSync(systemBundle, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!publicRoots?.trim()) {
    // Minimal Node images may omit the OS bundle. Keep public HTTPS trusted
    // for every child client by including Node's bundled Mozilla roots.
    publicRoots = rootCertificates.join('\n');
  }
  fs.writeFileSync(bundlePath, [publicRoots, ...certs.map(name => fs.readFileSync(path.join(certsDir, name), 'utf8'))].join('\n'));
  return {
    NODE_EXTRA_CA_CERTS: bundlePath,
    SSL_CERT_FILE: bundlePath,
    CURL_CA_BUNDLE: bundlePath,
    REQUESTS_CA_BUNDLE: bundlePath
  };
}
