FROM node:24-bookworm-slim AS build

WORKDIR /app

ARG REACT_APP_API_URL=/api
ARG REACT_APP_ALIYUN_CAPTCHA_PREFIX=
ARG REACT_APP_ALIYUN_CAPTCHA_SCENE_ID=

ENV REACT_APP_API_URL=${REACT_APP_API_URL}
ENV REACT_APP_ALIYUN_CAPTCHA_PREFIX=${REACT_APP_ALIYUN_CAPTCHA_PREFIX}
ENV REACT_APP_ALIYUN_CAPTCHA_SCENE_ID=${REACT_APP_ALIYUN_CAPTCHA_SCENE_ID}

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/public ./public
COPY frontend/scripts ./scripts
COPY frontend/src ./src

RUN npm run build

FROM nginx:1.27-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
COPY LICENSE NOTICE /usr/share/licenses/anna-bliver-fan-hub/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
