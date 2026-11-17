#!/usr/bin/env bash
# 构建 jpegtran -optimize wasm（任务 2 / DESIGN §11-2）。
# 产物：dist/jpegtran_opt.mjs（胶水）+ dist/jpegtran_opt.wasm（经 wabt 转 src/optimize/vendor/）。
# 依赖：Docker（emscripten/emsdk 镜像）。可重复执行。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist

# IJG jpegsrc 10（jpegtran-js 同源验证过可编译；-optimize 属 IJG jpegtran 基础能力）
if [ ! -d dist/jpegsrc ]; then
  curl -fsSL https://www.ijg.org/files/jpegsrc.v10.tar.gz -o dist/jpegsrc.tar.gz
  tar -xzf dist/jpegsrc.tar.gz -C dist
  mv dist/jpeg-10 dist/jpegsrc
fi

docker run --rm -v "$PWD":/work -w /work emscripten/emsdk:latest bash -c '
  set -e
  cd dist/jpegsrc
  emconfigure ./configure --disable-shared CFLAGS="-O3" >/dev/null
  emmake make -j"$(nproc)" libjpeg.la >/dev/null
  cd /work
  emcc wrapper.c dist/jpegsrc/.libs/libjpeg.a \
    -O3 \
    -I dist/jpegsrc \
    -s MODULARIZE=1 -s EXPORT_ES6=1 \
    -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=33554432 \
    -s EXPORTED_FUNCTIONS=_jpeg_optimize_huffman,_get_last_error,_malloc,_free \
    -s EXPORTED_RUNTIME_METHODS=cwrap,HEAPU8,HEAPU32 \
    -s ENVIRONMENT=web,worker \
    -o dist/jpegtran_opt.mjs
'

echo "build ok:"
ls -la dist/jpegtran_opt.wasm dist/jpegtran_opt.mjs
