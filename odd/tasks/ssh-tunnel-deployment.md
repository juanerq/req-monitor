# SSH tunnel deployment
Objective: Serve the local monitor through loopback-only Nginx and an SSH local forward, preserving the existing site.
Branch: feature/ssh-tunnel-deploy; delivery: ask-on-risk; runner: docker compose config, curl, nginx -t; forecast: under 100 authored lines.

## Specs
S1. "necesito que me ayudes a desplegar este proyecto en esta servidor, este servidor tiene nginx entonce usalo para exponerlo" Scope: deploy the monitor with Nginx on the server; acceptance: application and proxy respond without replacing the existing site.
S2. "Es la maquina donde esta el proyecto" Scope: the local host, not a remote target; acceptance: local-only execution.
S3. "Que sea desde tunnel" and "Tunnel con ssh" Scope: access through an SSH local forward rather than a publicly reachable virtual host; acceptance: monitor and Nginx bind only to loopback and the client can use an SSH local forward.

## Tasks
T1 [S1-S2] inline — complete; commit: pending — local Docker service healthy, loopback port and HTTP endpoints verified.
T2 [S1-S3] inline — partial; commit: pending — loopback Nginx site and SSH connection instructions verified in isolation; host activation and client SSH proof pending privileged/user action.

## Log
L1: necesito que me ayudes a desplegar este proyecto en esta servidor, este servidor tiene nginx entonce usalo para exponerlo
L2: Es la maquina donde esta el proyecto
L3: Que sea desde tunnel
L4: Tunnel con ssh
L5: Existing Nginx default site serves port 80 and proxies /api/ elsewhere; preserve it. SSH server is active. Docker is available but the monitor image is absent. Sudo requires a password, so activating the system site requires authorized privileged execution. Pre-existing .atl changes are unrelated and remain untouched.
L6: `docker compose up -d --build` passed; container healthy with only 127.0.0.1:8787 published. Direct and temporary unprivileged Nginx proxy /health return 200; / returns 200; Nginx isolated syntax test passes, binds only 127.0.0.1:8088, and existing port-80 response remained unchanged. Bind mount directories were initially root:root 755; restricted to local user uid/gid with mode 700 through the container. Future startup instructions create private directories before Compose. Independent verifier confirmed S2 and the proxy behavior, but S1/S3 remain pending host activation and client SSH-forward proof. Host Nginx cannot be activated without sudo password.
