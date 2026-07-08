FROM node:20-alpine

# Instalar FFmpeg + fuente para el intro de marca
RUN apk add --no-cache ffmpeg wget curl ttf-dejavu

WORKDIR /app

# Generar el intro de marca "Collapse Capital" (5s, colores de dinero ardiendo:
# rojo fuego + naranja brasa + dorado, con pista de audio silenciosa) en tiempo de
# build. Horneado en la imagen: cero red y cero coste por render. Desde el cambio a
# intro condicional, solo se antepone si el payload lo pide (source.intro).
RUN mkdir -p /app/assets && ffmpeg -y \
    -f lavfi -i "color=c=0x0a0402:s=1920x1080:d=5:r=25" \
    -f lavfi -i "anullsrc=r=44100:cl=stereo" \
    -filter_complex "\
[0:v]drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf:text='COLLAPSE':fontcolor=0xff3b13:fontsize=190:x=(w-text_w)/2:y=330,\
drawtext=fontfile=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf:text='CAPITAL':fontcolor=0xffb428:fontsize=190:x=(w-text_w)/2:y=560,\
drawbox=x=0:y=880:w=1920:h=6:color=0xff6a00@0.85:t=fill[base];\
[base]split=3[b1][b2][b3];\
[b2]gblur=sigma=18[glow1];[b3]gblur=sigma=45[glow2];\
[glow2][glow1]blend=all_mode=screen[gcomb];[gcomb][b1]blend=all_mode=screen[comb];\
[comb]fade=t=in:st=0:d=0.4,fade=t=out:st=4.5:d=0.5[vout]" \
    -map "[vout]" -map 1:a -t 5 -shortest \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -b:a 192k \
    /app/assets/intro.mp4

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
