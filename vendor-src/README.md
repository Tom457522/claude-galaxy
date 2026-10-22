# 3D グラフ用ライブラリのビルド元

`public/vendor/graph3d.bundle.js` は、次のライブラリを esbuild で 1 ファイルにまとめたものです(MIT ライセンス。ライセンス表記はバンドル末尾に含まれます)。
通常は再ビルド不要です(`npm install` / `npm start` だけで動きます)。

- 3d-force-graph 1.80.1 / three 0.186.1 / three-spritetext 1.10.0

再ビルドする場合(別のフォルダで実行):

```bash
mkdir build && cd build && npm init -y
npm install 3d-force-graph three three-spritetext esbuild
cp ../vendor-src/graph-entry.js .
npx esbuild graph-entry.js --bundle --minify --format=iife --target=es2020 --legal-comments=eof --outfile=../public/vendor/graph3d.bundle.js
```
