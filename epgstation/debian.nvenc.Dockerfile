FROM l3tnun/epgstation:master-debian

ENV DEBIAN_FRONTEND=noninteractive
ENV FFMPEG_VERSION=7.0

# 必要パッケージのインストール
RUN apt-get update && \
    apt-get install -y \
    nasm make gcc g++ git curl wget autoconf automake build-essential \
    pkg-config texinfo zlib1g-dev \
    libass-dev libfreetype6-dev libmp3lame-dev libopus-dev \
    libtheora-dev libtool libva-dev libvdpau-dev \
    libvorbis-dev libxcb1-dev libxcb-shm0-dev libxcb-xfixes0-dev \
    libx264-dev libx265-dev libnuma-dev libaribb24-dev libvpx-dev \
    ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# nv-codec-headers のインストール
RUN git clone https://github.com/FFmpeg/nv-codec-headers.git && \
    cd nv-codec-headers && \
    make && make install && \
    cd .. && rm -rf nv-codec-headers

# ffmpeg ソースからビルド（静的リンク）
RUN mkdir -p /tmp/ffmpeg_sources && \
    cd /tmp/ffmpeg_sources && \
    curl -fsSL https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 | tar -xj --strip-components=1 && \
    ./configure \
      --prefix=/usr/local \
      --disable-shared \
      --pkg-config-flags=--static \
      --extra-cflags=-I/usr/local/include \
      --extra-ldflags=-L/usr/local/lib \
      --enable-gpl \
      --enable-version3 \
      --enable-nonfree \
      --enable-libass \
      --enable-libfreetype \
      --enable-libmp3lame \
      --enable-libopus \
      --enable-libtheora \
      --enable-libvorbis \
      --enable-libvpx \
      --enable-libx264 \
      --enable-libx265 \
      --enable-libaribb24 \
      --enable-nvenc \
      --disable-debug \
      --disable-doc && \
    make -j$(nproc) && \
    make install && \
    rm -rf /tmp/ffmpeg_sources

# パス確認
RUN ffmpeg -version && ffmpeg -hwaccels && ffmpeg -encoders | grep nvenc
