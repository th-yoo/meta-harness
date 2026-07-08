# Terminal-Bench 2 — setup_deps generation report
Generated for 22 unhandled RUN lines across 59 tasks.
## Unhandled RUN directives (emitted verbatim in setup_deps.sh)

### circuit-fibsqrt
    apt-get update

### distribution-search
    apt-get update

### extract-elf
    gcc /app/hi.c -o /app/a.out

### feal-linear-cryptanalysis
    gcc -O3 -o feal feal.c
    gcc -O3 -o decrypt decrypt.c
    python3 gen.py

### financial-document-processor
    uv run /root/randomize_filenames.py

### fix-git
    bash /app/setup.sh

### gcode-to-text
    gzip -d /app/text.gcode.gz

### git-leak-recovery
    mkdir -p /app && chmod 755 /app
    chmod +x /app/challenge-setup.sh && bash /app/challenge-setup.sh && rm /app/challenge-setup.sh

### git-multibranch
    mkdir -p /etc/ssl/certs && mkdir -p /etc/ssl/private && openssl req -x509 -nodes -days 365 -subj "/CN=localhost" -newkey rsa:2048 -keyout /etc/ssl/private/nginx-selfsigned.key -out /etc/ssl/certs/nginx-selfsigned.crt
    mkdir -p /var/www/html /var/www/dev

### large-scale-text-editing
    python3 /app/gen_large_csv.py both && rm /app/gen_large_csv.py

### log-summary-date-ranges
    python3 /app/log_generator_deterministic.py

### password-recovery
    bash /app/setup.sh && rm /app/setup.sh

### path-tracing
    gcc -o orig /app/orig.c -lm
    ./orig

### path-tracing-reverse
    gcc -static -O3 -o mystery /app/orig.c -lm

### reshard-c4-data
    uv run setup.py

### sanitize-git-repo
    bash /app/setup.sh && rm /app/setup.sh

### write-compressor
    gcc -O3 decomp.c -o /app/decomp

## APT packages: to install (not currently on system)
  asciinema
  coq
  expect
  extundelete
  ffmpeg
  foremost
  libgl1-mesa-glx
  libglib2.0-0
  mailman3
  mailutils
  nginx
  npm
  openssh-server
  postfix
  primer3
  r-base
  rustc
  screen
  sleuthkit
  texlive-latex-base

## APT packages: already installed
  bc
  binutils
  build-essential
  ca-certificates
  curl
  e2fsprogs
  g++
  gcc
  git
  less
  libgomp1
  libjpeg-dev
  libsm6
  libxext6
  libxrender-dev
  nano
  net-tools
  nodejs
  openssl
  python3
  python3-pip
  sqlite3
  tmux
  unzip
  vim
  xxd
  zip
  zlib1g-dev

## One-time install command
```bash
sudo apt-get install -y \
  asciinema  \
  coq  \
  expect  \
  extundelete  \
  ffmpeg  \
  foremost  \
  libgl1-mesa-glx  \
  libglib2.0-0  \
  mailman3  \
  mailutils  \
  nginx  \
  npm  \
  openssh-server  \
  postfix  \
  primer3  \
  r-base  \
  rustc  \
  screen  \
  sleuthkit  \
  texlive-latex-base
```
