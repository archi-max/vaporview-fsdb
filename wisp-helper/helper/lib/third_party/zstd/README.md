# zstd decompressor (vendored)

zstd 1.5.7 (https://github.com/facebook/zstd/releases/tag/v1.5.7, `zstd-1.5.7.tar.gz`, SHA-256
`eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3`), the files a decompressor
needs, unmodified: `lib/zstd.h`, `lib/zstd_errors.h`, `lib/common/` (without `pool`, `threading`
and `xxhash.c`) and `lib/decompress/` (without the x86-64 assembly). `LICENSE` is zstd's BSD
licence; zstd is dual-licensed (BSD-3-Clause or GPL-2.0) and is used here under BSD-3-Clause.

`zstddec.c` (this project's) builds them as one translation unit with the defines of zstd's single-file
decoder template (`build/single_file_libs/zstddeclib-in.c`). `helper/build.sh` compiles it into the helper
(the decoder of its WCZ1 reader). To update: copy the same files from a newer release and record its
version and checksum here and in the repository's NOTICE.
