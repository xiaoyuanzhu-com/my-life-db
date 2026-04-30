#!/usr/bin/env bash
#
# Build the wangfenjin/simple SQLite FTS5 extension and place artifacts at
# $APP_DATA_DIR/extensions/libsimple.{so,dylib} + $APP_DATA_DIR/extensions/dict/.
#
# Source lives at backend/third_party/simple/ (a git submodule).
# Requires: cmake, a C/C++ toolchain. macOS uses Xcode CLT; Linux needs g++.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "${SCRIPT_DIR}")"
SIMPLE_DIR="${BACKEND_DIR}/third_party/simple"

if [[ ! -d "${SIMPLE_DIR}" ]]; then
  echo "Source missing at ${SIMPLE_DIR}. Run: git submodule update --init --recursive" >&2
  exit 1
fi

APP_DATA_DIR="${APP_DATA_DIR:-${BACKEND_DIR}/../.my-life-db}"
EXT_DIR="${APP_DATA_DIR}/extensions"
DICT_DIR="${EXT_DIR}/dict"

case "$(uname -s)" in
  Darwin) LIB_NAME="libsimple.dylib" ;;
  Linux)  LIB_NAME="libsimple.so" ;;
  *)      echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

BUILD_DIR="${SIMPLE_DIR}/build"

if [[ ! -f "${BUILD_DIR}/src/${LIB_NAME}" || "${1:-}" == "--force" ]]; then
  mkdir -p "${BUILD_DIR}"
  (cd "${BUILD_DIR}" && cmake -DCMAKE_BUILD_TYPE=Release -DBUILD_TEST_EXAMPLE=OFF ..)
  (cd "${BUILD_DIR}" && make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)")
fi

mkdir -p "${EXT_DIR}" "${DICT_DIR}"
cp -f "${BUILD_DIR}/src/${LIB_NAME}" "${EXT_DIR}/${LIB_NAME}"

# Dict files live under build/test/dict (cmake stages them there).
SRC_DICT="${BUILD_DIR}/test/dict"
for f in jieba.dict.utf8 hmm_model.utf8 user.dict.utf8 idf.utf8 stop_words.utf8; do
  cp -f "${SRC_DICT}/${f}" "${DICT_DIR}/${f}"
done

echo "Installed:"
echo "  ${EXT_DIR}/${LIB_NAME}"
echo "  ${DICT_DIR}/ (jieba dict files)"
