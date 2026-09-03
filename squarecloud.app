MAIN=server/index.js
DISPLAY_NAME=Cobra 3D TikTok LIVE
DESCRIPTION=Jogo da cobra 3D autonomo para lives do TikTok - presentes viram bombas (viloes) ou ajudas (herois). Overlay 9:16 + painel.
MEMORY=512
VERSION=recommended
RUNTIME=nodejs
SUBDOMAIN=cobra3d-live
START=HOST=0.0.0.0 PORT=80 node server/index.js
AUTORESTART=true
