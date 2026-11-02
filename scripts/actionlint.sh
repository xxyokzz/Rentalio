#!/usr/bin/env bash
# ============================================================
# Gate tambahan: validasi workflow GitHub Actions dengan actionlint
# (https://github.com/rhysd/actionlint).
#
# Dipakai di dua tempat dengan versi yang sama:
#   lokal : pnpm actionlint        (Linux/macOS/Git Bash)
#   CI    : langkah "Gate 0" pada .github/workflows/ci.yml
#
# Binari diunduh sekali ke .tools/ (di-.gitignore) dari halaman rilis resmi,
# dipin ke ACTIONLINT_VERSION — skrip unduhnya pun diambil dari tag yang sama,
# bukan dari main, agar skrip dan binari berasal dari rilis yang identik.
#
# Tanpa argumen, actionlint memindai semua workflow di .github/workflows
# (daftar berkas ditentukan eksplisit oleh skrip — lihat akhir berkas).
# Lewati unduhan bila binari sudah ada; set ACTIONLINT_VERSION untuk memaksa
# versi lain (binari berbeda versi disimpan di berkas yang sama → hapus .tools/
# dulu bila ingin mengganti).
# ============================================================
set -euo pipefail

ACTIONLINT_VERSION="${ACTIONLINT_VERSION:-1.7.12}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${REPO_ROOT}/.tools"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) BIN="${TOOLS_DIR}/actionlint.exe" ;;
  *) BIN="${TOOLS_DIR}/actionlint" ;;
esac

if [[ ! -x "${BIN}" ]]; then
  mkdir -p "${TOOLS_DIR}"
  echo "Mengunduh actionlint v${ACTIONLINT_VERSION} ke ${TOOLS_DIR} ..." >&2
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  curl -fsSL \
    "https://raw.githubusercontent.com/rhysd/actionlint/v${ACTIONLINT_VERSION}/scripts/download-actionlint.bash" \
    -o "${TMP_DIR}/download-actionlint.bash"
  bash "${TMP_DIR}/download-actionlint.bash" "${ACTIONLINT_VERSION}" "${TOOLS_DIR}"
  rm -rf "${TMP_DIR}"
  trap - EXIT
fi

if [[ ! -x "${BIN}" ]]; then
  echo "Binari actionlint tidak ditemukan di ${BIN}" >&2
  exit 1
fi

echo "$("${BIN}" -version)"
cd "${REPO_ROOT}"

# Tanpa argumen actionlint mencari root proyek lewat direktori .git; workspace
# ini belum selalu berbentuk repo Git, sehingga daftar berkas workflow disebut
# eksplisit. Perilakunya sama di repo Git maupun tidak.
if [[ $# -eq 0 ]]; then
  shopt -s nullglob
  workflows=( .github/workflows/*.yml .github/workflows/*.yaml )
  shopt -u nullglob
  if [[ ${#workflows[@]} -eq 0 ]]; then
    echo "Tidak ada berkas workflow di .github/workflows" >&2
    exit 1
  fi
  set -- "${workflows[@]}"
fi

exec "${BIN}" "$@"
