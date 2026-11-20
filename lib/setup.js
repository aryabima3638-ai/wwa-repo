// Auto setup GitHub: bot membuat / memperbarui file workflow di repo lewat API (tanpa upload manual)
const S = require('../setting');
const gh = require('./github');

// "§" diganti "$" supaya tidak bentrok dengan template literal JS
const fix = (s) => s.replace(/§/g, '$');

const FIND_ROOT = `
          mkdir -p source
          gh release download "§{{ inputs.tag }}" --repo §{{ github.repository }} --pattern "*.zip" --dir source
          cd source
          unzip -q -o ./source.zip || unzip -q -o ./*.zip
          PUB=$(find . -name pubspec.yaml -not -path '*/__MACOSX/*' -not -path '*/.dart_tool/*' -not -path '*/ephemeral/*' -not -path '*/example/*' -not -path '*/.symlinks/*' | awk '{print length, $0}' | sort -n | sed -n '1p' | cut -d' ' -f2- || true)
          if [ -z "$PUB" ]; then
            echo "Isi ZIP (3 level teratas):"
            find . -maxdepth 3 | head -60 || true
            echo "::error::pubspec.yaml tidak ditemukan di dalam ZIP. Zip folder project Flutter yang ada pubspec.yaml."
            exit 1
          fi
          ROOT=$(cd "$(dirname "$PUB")" && pwd)
          echo "PROJECT_ROOT=$ROOT" >> "$GITHUB_ENV"
          echo "Project root: $ROOT"`;

const FLUTTER = fix(`name: Build Flutter
run-name: Build §{{ inputs.tag }} (§{{ inputs.build_type }})

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag yang berisi source ZIP
        required: true
      build_type:
        description: release atau debug
        default: release

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - name: Bebaskan ruang disk
        run: |
          sudo rm -rf /usr/share/dotnet /opt/ghc /usr/local/share/boost || true

      - uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.32.8'
          channel: stable

      - name: Download & extract source ZIP
        env:
          GH_TOKEN: §{{ secrets.GITHUB_TOKEN }}
        run: |${FIND_ROOT}

      - name: Flutter build
        run: |
          cd "$PROJECT_ROOT"
          flutter pub get
          if [ "§{{ inputs.build_type }}" = "debug" ]; then
            flutter build apk --debug
          else
            flutter build apk --release
          fi

      - uses: actions/upload-artifact@v4
        with:
          name: app-§{{ inputs.build_type }}
          path: §{{ env.PROJECT_ROOT }}/build/app/outputs/flutter-apk/*.apk
          if-no-files-found: error
          retention-days: 1
`);

const WEB = fix(`name: Build Flutter Web
run-name: Build §{{ inputs.tag }} (web)

on:
  workflow_dispatch:
    inputs:
      tag:
        description: Release tag yang berisi source ZIP
        required: true

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - name: Bebaskan ruang disk
        run: |
          sudo rm -rf /usr/share/dotnet /opt/ghc /usr/local/share/boost || true

      - uses: subosito/flutter-action@v2
        with:
          flutter-version: '3.32.8'
          channel: stable

      - name: Download & extract source ZIP
        env:
          GH_TOKEN: §{{ secrets.GITHUB_TOKEN }}
        run: |${FIND_ROOT}

      - name: Flutter build web
        run: |
          cd "$PROJECT_ROOT"
          flutter config --enable-web
          flutter pub get
          flutter build web --release

      - uses: actions/upload-artifact@v4
        with:
          name: web-build
          path: §{{ env.PROJECT_ROOT }}/build/web
          if-no-files-found: error
          retention-days: 1
`);

async function put(file, content, branch) {
  const p = `/repos/${S.github.repo}/contents/.github/workflows/${file}`;
  let sha;
  try {
    const cur = await gh.api('GET', `${p}?ref=${encodeURIComponent(branch)}`);
    if (Buffer.from(cur.content, 'base64').toString('utf8') === content) return 'sudah terbaru';
    sha = cur.sha;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const body = { message: `bot: ${sha ? 'update' : 'tambah'} ${file}`, content: Buffer.from(content).toString('base64'), branch };
  if (sha) body.sha = sha;
  try {
    await gh.api('PUT', p, { body });
  } catch (e) {
    if (e.status === 404 || e.status === 409 || e.status === 422) { // repo kosong / branch belum ada
      delete body.branch;
      await gh.api('PUT', p, { body });
    } else throw e;
  }
  return sha ? 'diperbarui' : 'dibuat';
}

// Mengembalikan teks laporan; throw kalau token/repo salah
async function ensure() {
  const repo = await gh.api('GET', `/repos/${S.github.repo}`);
  if (!repo.permissions?.push) throw new Error('Token tidak punya akses push ke repo ini (butuh scope repo + workflow).');
  try {
    await gh.api('GET', `/repos/${S.github.repo}/branches/${encodeURIComponent(S.github.branch)}`);
  } catch (e) {
    if (e.status === 404 && repo.default_branch) S.github.branch = repo.default_branch;
  }
  const b = S.github.branch;
  const r1 = await put(S.github.flutterWorkflow, FLUTTER, b);
  const r2 = await put(S.github.webWorkflow, WEB, b);
  return `📱 ${S.github.flutterWorkflow}: ${r1}\n🌐 ${S.github.webWorkflow}: ${r2}\n🌿 Branch: ${S.github.branch}`;
}

module.exports = { ensure };
