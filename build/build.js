'use strict';
// Packages the Mirrorly app for Windows x64 from the prebuilt Electron zip.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const asar = require('@electron/asar');
const ResEdit = require('resedit');
const PELibrary = require('pe-library');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const DIST = path.join(__dirname, 'dist');
const OUT = path.join(DIST, 'Mirrorly');
const STAGE = path.join(__dirname, 'stage');
const ELECTRON_ZIP = process.env.ELECTRON_ZIP || '/tmp/electron-win.zip';
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (!filter(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, filter); else fs.copyFileSync(s, d);
  }
}

(async () => {
  rm(DIST); rm(STAGE);
  fs.mkdirSync(OUT, { recursive: true });
  execFileSync('unzip', ['-q', ELECTRON_ZIP, '-d', OUT]);
  rm(path.join(OUT, 'resources', 'default_app.asar'));
  for (const f of fs.readdirSync(path.join(OUT, 'locales'))) {
    if (!['en-US.pak', 'uk.pak'].includes(f)) fs.rmSync(path.join(OUT, 'locales', f));
  }
  fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'Mirrorly.exe'));
  fs.renameSync(path.join(OUT, 'LICENSE'), path.join(OUT, 'LICENSE.electron.txt'));

  // ---- stage the app sources ----
  const runtimeModules = new Set(['multicast-dns', 'dns-packet', 'thunky', '@leichtgewicht']);
  copyDir(APP, STAGE, (s, e) => {
    const rel = path.relative(APP, s).split(path.sep);
    if (rel[0] === 'node_modules' && rel.length === 2 && !runtimeModules.has(rel[1])) return false;
    if (rel[0] === 'package-lock.json') return false;
    if (e.isFile() && /\.(md|ts|map)$/i.test(e.name) && rel[0] === 'node_modules') return false;
    return true;
  });
  await asar.createPackageWithOptions(STAGE, path.join(OUT, 'resources', 'app.asar'), {});

  // ---- licences / notices ----
  fs.copyFileSync(path.join(ROOT, 'native', 'playfair', 'LICENSE.md'), path.join(OUT, 'LICENSE.txt'));
  fs.copyFileSync(path.join(ROOT, 'native', 'fdk-aac', 'NOTICE'), path.join(OUT, 'NOTICE.fdk-aac.txt'));
  fs.copyFileSync(path.join(APP, 'renderer', 'fonts', 'LICENSE-Inter.txt'), path.join(OUT, 'LICENSE.Inter-font.txt'));
  fs.writeFileSync(path.join(OUT, 'README.txt'), [
    'Mirrorly ' + pkg.version + ' — повтор екрана iPhone/iPad на Windows (AirPlay-приймач).',
    '',
    'Програма використовує:',
    ' • алгоритм FairPlay "playfair" з проєкту UxPlay/shairplay (GPL-3.0) — див. LICENSE.txt;',
    ' • Fraunhofer FDK AAC для декодування звуку AAC-ELD — див. NOTICE.fdk-aac.txt;',
    ' • Electron/Chromium — див. LICENSE.electron.txt і LICENSES.chromium.html;',
    ' • шрифт Inter (SIL OFL 1.1) — див. LICENSE.Inter-font.txt.',
    '',
    'AirPlay та iPhone є торговими марками Apple Inc. Mirrorly не пов’язана з Apple.',
    '',
  ].join('\r\n'), 'utf8');

  // ---- exe icon + version info ----
  const exePath = path.join(OUT, 'Mirrorly.exe');
  const exe = PELibrary.NtExecutable.from(fs.readFileSync(exePath));
  const res = PELibrary.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(APP, 'assets', 'icon.ico')));
  const existing = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = existing.length ? existing[0].id : 1;
  const lang = existing.length ? existing[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map(i => i.data));
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const [maj, min, pat] = pkg.version.split('.').map(Number);
  vi.setFileVersion(maj, min, pat, 0, 1033);
  vi.setProductVersion(maj, min, pat, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: 'Mirrorly',
    FileDescription: 'Mirrorly — повтор екрана iPhone',
    CompanyName: 'Mirrorly',
    LegalCopyright: '© 2026 Mirrorly. GPL-3.0',
    OriginalFilename: 'Mirrorly.exe',
    InternalName: 'Mirrorly',
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('Packaged app at', OUT);
})().catch(e => { console.error(e); process.exit(1); });
