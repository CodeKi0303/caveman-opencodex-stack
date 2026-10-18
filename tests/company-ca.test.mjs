import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {rootCertificates} from 'node:tls';
import {execFile, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {companyCaEnvironment} from '../src/company-ca.mjs';

const exec = promisify(execFile);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-company-ca-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const certsDir = path.join(dir, 'certs');
  fs.mkdirSync(certsDir);
  return {dir, certsDir, systemBundle: path.join(dir, 'system-ca.pem'), bundlePath: path.join(dir, 'bundle.pem')};
}

test('company CA preserves the system bundle and excludes inbound server certificates', t => {
  const paths = fixture(t);
  fs.writeFileSync(paths.systemBundle, rootCertificates[0]);
  fs.writeFileSync(path.join(paths.certsDir, 'company.crt'), rootCertificates[1]);
  fs.writeFileSync(path.join(paths.certsDir, 'intermediate.pem'), rootCertificates[2]);
  fs.writeFileSync(path.join(paths.certsDir, 'server.crt'), 'inbound-server-certificate');
  fs.writeFileSync(path.join(paths.certsDir, 'README.md'), 'not a certificate');
  assert.deepEqual(companyCaEnvironment(paths), {
    NODE_EXTRA_CA_CERTS: paths.bundlePath,
    SSL_CERT_FILE: paths.bundlePath,
    CURL_CA_BUNDLE: paths.bundlePath,
    REQUESTS_CA_BUNDLE: paths.bundlePath
  });
  assert.equal(fs.readFileSync(paths.bundlePath, 'utf8'), rootCertificates.slice(0, 3).join('\n'));
});

test('company CA uses all built-in Node roots when the system bundle is absent or empty', async t => {
  for (const empty of [false, true]) {
    await t.test(empty ? 'empty system bundle' : 'missing system bundle', t => {
      const paths = fixture(t);
      if (empty) fs.writeFileSync(paths.systemBundle, '\n  \n');
      fs.writeFileSync(path.join(paths.certsDir, 'company.pem'), rootCertificates[0]);
      companyCaEnvironment(paths);
      assert.equal(fs.readFileSync(paths.bundlePath, 'utf8'), [...rootCertificates, rootCertificates[0]].join('\n'));
    });
  }
});

test('without company certificates the existing client trust settings are untouched', t => {
  const paths = fixture(t);
  fs.writeFileSync(path.join(paths.certsDir, 'server.crt'), 'inbound-server-certificate');
  assert.deepEqual(companyCaEnvironment(paths), {});
  fs.rmSync(paths.certsDir, {recursive: true});
  assert.deepEqual(companyCaEnvironment(paths), {});
  assert.equal(fs.existsSync(paths.bundlePath), false);
});

test('company CA does not hide system bundle or company certificate read errors', t => {
  const paths = fixture(t);
  fs.writeFileSync(path.join(paths.certsDir, 'company.crt'), rootCertificates[0]);
  fs.mkdirSync(paths.systemBundle);
  assert.throws(() => companyCaEnvironment(paths), {code: 'EISDIR'});
  fs.rmSync(paths.systemBundle, {recursive: true});
  fs.unlinkSync(path.join(paths.certsDir, 'company.crt'));
  fs.symlinkSync(path.join(paths.dir, 'missing.crt'), path.join(paths.certsDir, 'company.crt'));
  assert.throws(() => companyCaEnvironment(paths), {code: 'ENOENT'});
  assert.equal(fs.existsSync(paths.bundlePath), false);
});

test('fallback bundle verifies private-CA HTTPS through Node and OpenSSL trust settings', async t => {
  const paths = fixture(t);
  const caCert = path.join(paths.certsDir, 'company.crt');
  const caKey = path.join(paths.dir, 'ca.key');
  const serverKey = path.join(paths.dir, 'server.key');
  const serverCsr = path.join(paths.dir, 'server.csr');
  const serverCert = path.join(paths.certsDir, 'server.crt');
  const extensions = path.join(paths.dir, 'server.ext');
  const openssl = args => execFileSync('openssl', args, {stdio: 'ignore'});
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCert,
    '-days', '1', '-subj', '/CN=Stack company test CA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', serverCsr,
    '-subj', '/CN=localhost']);
  fs.writeFileSync(extensions, 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n');
  openssl(['x509', '-req', '-in', serverCsr, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial',
    '-out', serverCert, '-days', '1', '-extfile', extensions]);

  const server = https.createServer({key: fs.readFileSync(serverKey), cert: fs.readFileSync(serverCert)},
    (_req, res) => res.end('verified'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'https://127.0.0.1:' + server.address().port;
  const code = `require('node:https').get(process.argv[1], response => {
    response.pipe(process.stdout);
  }).on('error', error => { console.error(error.code); process.exitCode = 1; });`;
  const env = {...process.env};
  for (const name of ['NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS',
    'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) delete env[name];
  const client = (extraEnv, args = []) => exec(process.execPath, [...args, '-e', code, url], {
    env: {...env, ...extraEnv}, timeout: 10000
  });
  await assert.rejects(client({}), error => error.code === 1 &&
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/.test(error.stderr));
  const caEnv = companyCaEnvironment(paths);
  assert.equal((await client(caEnv)).stdout, 'verified');
  // Exercise SSL_CERT_FILE alone, as used by non-Node clients in the pod.
  assert.equal((await client({SSL_CERT_FILE: caEnv.SSL_CERT_FILE}, ['--use-openssl-ca'])).stdout, 'verified');
  assert.equal(fs.readFileSync(paths.bundlePath, 'utf8').includes(fs.readFileSync(serverCert, 'utf8')), false);
});
