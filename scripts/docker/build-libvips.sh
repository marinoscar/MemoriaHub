#!/bin/sh
# Compile libvips from source into /opt/vips with libheif (HEVC via the
# libde265 plugin) enabled. Shared by apps/api/Dockerfile and apps/cli/Dockerfile
# (`vips` stage) so the server and the worker link the IDENTICAL libvips build.
#
# Why: sharp 0.35.x needs libvips >= 8.18.3 to build against a system libvips,
# and Debian trixie ships 8.16, so the previous `npm rebuild sharp
# --build-from-source` built nothing and sharp kept its bundled libvips, which
# has no HEVC decoder (RETRO-J, #593/#616). 8.18.3 is the version sharp 0.35.3
# bundles, so resampling output matches the golden vectors.
set -eu

VIPS_VERSION="${VIPS_VERSION:-8.18.3}"
VIPS_SHA256="${VIPS_SHA256:-f41285b61bfb495605494f074ca341f7791a1d406e2f157dcea606ef1ae1b146}"
PREFIX=/opt/vips

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates wget xz-utils build-essential pkg-config meson ninja-build \
  libglib2.0-dev libexpat1-dev libjpeg-dev libpng-dev libwebp-dev libtiff-dev \
  libheif-dev libexif-dev liblcms2-dev librsvg2-dev libhwy-dev \
  libcgif-dev libspng-dev libimagequant-dev libfftw3-dev
rm -rf /var/lib/apt/lists/*

cd /tmp
wget -q "https://github.com/libvips/libvips/releases/download/v${VIPS_VERSION}/vips-${VIPS_VERSION}.tar.xz" -O vips.tar.xz
echo "${VIPS_SHA256}  vips.tar.xz" | sha256sum -c -
tar xf vips.tar.xz
cd "vips-${VIPS_VERSION}"

meson setup build --prefix="${PREFIX}" --libdir=lib --buildtype=release \
  -Dheif=enabled -Djpeg=enabled -Dpng=enabled -Dwebp=enabled -Dtiff=enabled \
  -Dexif=enabled -Dlcms=enabled -Dhighway=enabled -Dorc=disabled -Dcplusplus=true \
  -Dmodules=disabled -Dintrospection=disabled -Dvapi=false -Dexamples=false \
  -Ddeprecated=false
meson compile -C build
meson install -C build
strip --strip-unneeded "${PREFIX}"/lib/libvips*.so* || true
rm -rf "${PREFIX}/bin" "${PREFIX}/share" /tmp/vips.tar.xz "/tmp/vips-${VIPS_VERSION}"
PKG_CONFIG_PATH="${PREFIX}/lib/pkgconfig" pkg-config --modversion vips-cpp
