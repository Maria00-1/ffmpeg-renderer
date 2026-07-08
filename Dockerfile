FROM node:20-alpine

# Instalar FFmpeg + fuente para el intro de marca
RUN apk add --no-cache ffmpeg wget curl ttf-dejavu

WORKDIR /app

# Generar el intro de marca "Collapse Capital" (neon rojo/dorado, 4s, con pista de
# audio silenciosa) en tiempo de build. Horneado en la imagen: cero red y cero coste
# por render, y consistente en todos los videos (igual que cualquier bumper de canal).
RUN mkdir -p /app/assets && ffmpeg -y \
    -f lavfi -i "color=c=0x05050a:s=1920x1080:d=4:r=25" \
    -f lavfi -i "anullsrc=r=44100:cl=stereo" \
    -filter_complex "\
[0:v]drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf:text='COLLAPSE':fontcolor=0xff2a2a:fontsize=190:x=(w-text_w)/2:y=330,\
drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf:text='CAPITAL':fontcolor=0xffc94d:fontsize=190:x=(w-text_w)/2:y=560[base];\
[base]split=2[b1][b2];[b2]gblur=sigma=22[glow];[glow][b1]blend=all_mode=screen[comb];\
[comb]fade=t=in:st=0:d=0.3[vout]" \
    -map "[vout]" -map 1:a -t 4 -shortest \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 192k \
    /app/assets/intro.mp4

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
