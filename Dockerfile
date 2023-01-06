# From the official nodejs image, based on Debian Jessy
FROM node:16-slim

# Install imagemagick
RUN apt-get update && \
    apt-get install -y graphicsmagick git wget tar xz-utils && \
    rm -rf /var/lib/apt/lists/*

# Install ffmpeg
RUN arch=$(arch | sed s/aarch64/arm64/ | sed s/x86_64/amd64/) \
    && mkdir -p /opt/ffmpeg \
    && wget -c "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arch}-static.tar.xz" -O /opt/ffmpeg/ffmpeg.tar.xz \
    && tar xvf /opt/ffmpeg/ffmpeg.tar.xz --strip-components=1 -C /opt/ffmpeg/ \
    && ln -s "/opt/ffmpeg/ffmpeg" /usr/local/bin/ \
    && ln -s "/opt/ffmpeg/ffprobe" /usr/local/bin/

# Building
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY package.json /usr/src/app/
RUN npm install
COPY *bower* /usr/src/app/
RUN node node_modules/bower/bin/bower install --allow-root
COPY . /usr/src/app

# Default HTTP port
EXPOSE 8075

# Start the server
CMD ["node", "server.js"]
