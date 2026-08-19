FROM python:3.13-slim-bookworm
WORKDIR /app
# The probe's whole substance: an image in the agent's workspace whose content
# exists nowhere in text. Copied in, never generated here, so the container
# build cannot leak the token into a layer's command line.
COPY token.png /app/token.png
